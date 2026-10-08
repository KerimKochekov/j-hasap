"""Local BLE transport for the BT-802. The HTTP server needs no Bluetooth imports."""
import asyncio
import base64
import json
from pathlib import Path
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parent
PRINT_LOCK = threading.Lock()
PRINT_BLOCK_REASON = ''
MAX_HEIGHT = 8000
TRANSFER_BYTES_PER_SECOND = 8000
MAX_WRITE_CHUNK = 180
WRITE_UUID = '0000ff02-0000-1000-8000-00805f9b34fb'
STATUS_UUID = '0000ff01-0000-1000-8000-00805f9b34fb'
SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb'
TEST_WIDTH, TEST_HEIGHT = 576, 240


def available():
    return sys.platform == 'darwin' and (ROOT / '.venv-printer/bin/python').is_file()


def validate_raster(body):
    width, height = body.get('width'), body.get('height')
    if type(width) is not int or width not in (384, 576) or type(height) is not int or not 1 <= height <= MAX_HEIGHT:
        raise ValueError('Invalid receipt image dimensions.')
    if not isinstance(body.get('data'), str):
        raise ValueError('Invalid receipt image data.')
    try:
        data = base64.b64decode(body['data'], validate=True)
    except ValueError:
        raise ValueError('Invalid receipt image data.')
    if len(data) != width // 8 * height:
        raise ValueError('Invalid receipt image data.')
    return width, height, data


def raster_packets(width, height, data):
    """ESC/POS raster jobs for the BT-802 (self-test: CMD Type ESC).

    GS v 0 takes width in bytes and height in dots, little endian; 1 is black.
    Bands stay below the portable printer's bitmap buffer limit. There are no
    label-size, gap-search, form-feed, cut, or repeat commands.
    """
    row_bytes = width // 8
    yield b'\x1b@\x1bS\x1ba\x00'  # Initialize, standard mode, left aligned.
    for top in range(0, height, 128):
        rows = min(128, height - top)
        bitmap = data[top * row_bytes:(top + rows) * row_bytes]
        yield b'\x1dv0\x00' + row_bytes.to_bytes(2, 'little') + rows.to_bytes(2, 'little') + bitmap
    yield b'\x1bJ\x20'  # Only 32 dots of extra feed for tear-off.


async def send_packets(client, characteristic, packets):
    """Use negotiated BLE payload sizes with a bounded printer input rate.

    Keep each raster band intact and await every write; never retry a partial job.
    Cap larger negotiated payloads to limit the printer's receive-buffer burst.
    """
    limit = getattr(characteristic, 'max_write_without_response_size', 20)
    chunk_size = min(limit, MAX_WRITE_CHUNK) if type(limit) is int and limit > 0 else 20
    sent = 0
    for packet in packets:
        for offset in range(0, len(packet), chunk_size):
            chunk = packet[offset:offset + chunk_size]
            await client.write_gatt_char(characteristic, chunk, response=False)
            sent += len(chunk)
            await asyncio.sleep(len(chunk) / TRANSFER_BYTES_PER_SECOND)
    return sent, chunk_size


def check_status(status, kind=2):
    """Decode ESC/POS DLE EOT offline (2) or paper (4) status.

    Bits 1 and 4 must be set, bits 0 and 7 clear. Ignore unsupported replies
    rather than decoding a vendor/TSPL byte as an ESC/POS fault or ready state.
    """
    if status is None or status & 0x93 != 0x12:
        return
    if kind == 4:
        if status & 0x60:
            raise ValueError('BT-802 reports no paper. Check the roll before printing.')
        return
    if status & 4:
        raise ValueError('BT-802 reports an open cover. Close it firmly before printing.')
    if status & 32:
        raise ValueError('BT-802 reports no paper. Check the roll before printing.')
    if status & 64:
        raise ValueError('BT-802 reports an error. Check its ERROR light and paper before printing again.')
    if status & 8:
        raise ValueError('BT-802 is feeding paper. Wait before printing again.')


def run_bridge(action, device_id=None, raster=None):
    if action in ('print', 'test') and PRINT_BLOCK_REASON:
        raise ValueError(PRINT_BLOCK_REASON)
    if not available():
        raise ValueError('Bluetooth printing is not installed on this computer.')
    if not PRINT_LOCK.acquire(blocking=False):
        raise ValueError('The Bluetooth printer is busy. Please wait.')
    try:
        payload = {'action': action, 'deviceId': device_id}
        if raster is not None:
            validate_raster(raster)
            payload['raster'] = raster
        result = subprocess.run(
            [str(ROOT / '.venv-printer/bin/python'), str(Path(__file__).resolve()), '--worker'],
            input=json.dumps(payload), capture_output=True, text=True, timeout=480 if action == 'print' else 35,
        )
        try:
            response = json.loads(result.stdout)
        except ValueError:
            raise ValueError('Bluetooth access failed. Allow Bluetooth access in macOS Privacy & Security settings.')
        if not response.get('ok'):
            raise ValueError(response.get('error', 'Could not connect to the Bluetooth printer.'))
        return response
    except subprocess.TimeoutExpired:
        # Never retry automatically: a partial receipt might have reached the printer.
        raise ValueError('Bluetooth printing timed out. Check the paper before printing again.')
    finally:
        PRINT_LOCK.release()


async def find_printer(device_id):
    from bleak import BleakScanner
    from bleak.backends.device import BLEDevice
    from bleak.backends.corebluetooth.CentralManagerDelegate import CentralManagerDelegate
    from CoreBluetooth import CBUUID
    from Foundation import NSUUID
    manager = CentralManagerDelegate()
    await manager.wait_until_ready()
    peripherals = []
    if device_id:
        identifier = NSUUID.alloc().initWithUUIDString_(device_id)
        if identifier:
            peripherals = manager.central_manager.retrievePeripheralsWithIdentifiers_([identifier])
    if not peripherals:
        peripherals = manager.central_manager.retrieveConnectedPeripheralsWithServices_([CBUUID.UUIDWithString_(SERVICE_UUID)])
    candidates = [p for p in peripherals if p.name() and ('802' in p.name().upper())]
    if len(candidates) > 1:
        raise ValueError('More than one BT-802 is connected. Disconnect the other printer and try again.')
    if candidates:
        peripheral = candidates[0]
        return BLEDevice(peripheral.identifier().UUIDString(), peripheral.name(), (peripheral, manager))
    return await BleakScanner.find_device_by_filter(
        lambda device, advert: any('802' in name.upper() for name in [device.name or '', advert.local_name or '']),
        timeout=8,
    )


async def worker(request):
    # Also guard here: a running HTTP server may have imported an older bridge.
    # Every job launches this file in a fresh process.
    if request.get('action') in ('print', 'test') and PRINT_BLOCK_REASON:
        raise ValueError(PRINT_BLOCK_REASON)
    from bleak import BleakClient
    device = await find_printer(request.get('deviceId'))
    if not device:
        raise ValueError('BT-802 was not found. Turn it on and connect it to this Mac.')
    async with BleakClient(device, timeout=15) as client:
        characteristic = client.services.get_characteristic(WRITE_UUID)
        if not characteristic or 'write-without-response' not in characteristic.properties:
            raise ValueError('This printer does not expose the supported BT-802 printing service.')
        status_queue = asyncio.Queue()
        status_characteristic = client.services.get_characteristic(STATUS_UUID)
        if status_characteristic and 'notify' in status_characteristic.properties:
            def receive_status(sender, data):
                if len(data) == 1:
                    status_queue.put_nowait(data[0])
            await client.start_notify(status_characteristic, receive_status)

        async def read_status(kind):
            if not status_characteristic or 'notify' not in status_characteristic.properties:
                return None
            while not status_queue.empty():
                status_queue.get_nowait()
            await client.write_gatt_char(characteristic, bytes([0x10, 0x04, kind]), response=False)
            try:
                reply = await asyncio.wait_for(status_queue.get(), timeout=1.5)
                return reply if reply & 0x93 == 0x12 else None
            except asyncio.TimeoutError:
                return None

        status = await read_status(2)
        check_status(status, 2)
        paper_status = await read_status(4)
        check_status(paper_status, 4)
        action = request['action']
        if action == 'test':
            data = (ROOT / 'printer-test.bin').read_bytes()
            if len(data) != TEST_WIDTH // 8 * TEST_HEIGHT:
                raise ValueError('Invalid receipt image data.')
            packets = raster_packets(TEST_WIDTH, TEST_HEIGHT, data)
        elif action == 'print':
            width, height, data = validate_raster(request['raster'])
            packets = raster_packets(width, height, data)
        elif action == 'connect':
            packets = []
        else:
            raise ValueError('Unknown Bluetooth printer action.')
        sent, chunk_size = await send_packets(client, characteristic, packets)
        if sent:
            await asyncio.sleep(1)
            status = await read_status(2)
            check_status(status, 2)
            paper_status = await read_status(4)
            check_status(paper_status, 4)
        return {'ok': True, 'deviceId': device.address, 'name': device.name, 'bytesSent': sent,
                'status':status, 'paperStatus':paper_status, 'protocol':'escpos', 'chunkSize':chunk_size}


if __name__ == '__main__':
    try:
        result = asyncio.run(worker(json.load(sys.stdin)))
    except asyncio.TimeoutError:
        result = {'ok':False, 'error':'BT-802 did not respond. Turn it on and check its Bluetooth connection.'}
    except Exception as error:
        result = {'ok': False, 'error': str(error) or type(error).__name__}
    print(json.dumps(result), flush=True)
