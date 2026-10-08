import base64
import asyncio
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from bluetooth_printer import PRINT_LOCK, WRITE_UUID, STATUS_UUID, check_status, raster_packets, run_bridge, validate_raster, worker, send_packets, TRANSFER_BYTES_PER_SECOND


class BluetoothPrinterTests(unittest.TestCase):
    @patch("bluetooth_printer.PRINT_BLOCK_REASON", "feeds paper continuously")
    def test_faulty_transport_is_blocked_before_any_bluetooth_access(self):
        for action in ('print', 'test'):
            with self.subTest(action=action), patch('bluetooth_printer.subprocess.run') as run:
                with self.assertRaisesRegex(ValueError, 'feeds paper continuously'):
                    run_bridge(action)
                run.assert_not_called()
                with patch('bluetooth_printer.find_printer', new=AsyncMock()) as find:
                    with self.assertRaisesRegex(ValueError, 'feeds paper continuously'):
                        asyncio.run(worker({'action':action}))
                    find.assert_not_called()

    def test_image_validation_and_band_order(self):
        width, height = 576, 257
        data = bytes(i % 256 for i in range(width // 8 * height))
        raster = {'width':width, 'height':height, 'data':base64.b64encode(data).decode()}
        self.assertEqual(validate_raster(raster), (width,height,data))
        packets = list(raster_packets(width,height,data))
        self.assertEqual(packets[0], b'\x1b@\x1bS\x1ba\x00')
        reconstructed = bytearray()
        for index, packet in enumerate(packets[1:-1]):
            self.assertEqual(packet[:4], b'\x1dv0\x00')
            self.assertEqual(int.from_bytes(packet[4:6], 'little'), width // 8)
            rows = min(128, height - index * 128)
            self.assertEqual(int.from_bytes(packet[6:8], 'little'), rows)
            self.assertEqual(len(packet), 8 + width // 8 * rows)
            reconstructed.extend(packet[8:])
        self.assertEqual(bytes(reconstructed), data)
        self.assertEqual(packets[-1], b'\x1bJ\x20')

    def test_fast_transfer_preserves_all_bytes_and_negotiated_limits(self):
        data = bytes(i % 256 for i in range(576//8*257))
        packets = list(raster_packets(576,257,data))
        for limit,expected in [(20,20),(64,64),(244,180),(512,180),(None,20)]:
            with self.subTest(limit=limit):
                writes=[]
                async def write(char,chunk,response):
                    self.assertFalse(response)
                    self.assertLessEqual(len(chunk),expected)
                    writes.append(chunk)
                client=SimpleNamespace(write_gatt_char=write)
                characteristic=SimpleNamespace(max_write_without_response_size=limit)
                with patch('bluetooth_printer.asyncio.sleep',new=AsyncMock()) as sleep:
                    sent,chunk_size=asyncio.run(send_packets(client,characteristic,packets))
                self.assertEqual(b''.join(writes),b''.join(packets))
                self.assertEqual(chunk_size,expected)
                self.assertEqual(sent,len(b''.join(packets)))
                total_pause=sum(call.args[0] for call in sleep.call_args_list)
                self.assertAlmostEqual(total_pause,sent/TRANSFER_BYTES_PER_SECOND)
                self.assertLess(total_pause,(sent/20)*.008)

    def test_fast_transfer_stops_on_error_without_retrying(self):
        client=SimpleNamespace(write_gatt_char=AsyncMock(side_effect=OSError('Disconnected')))
        with patch('bluetooth_printer.asyncio.sleep',new=AsyncMock()) as sleep:
            with self.assertRaises(OSError):
                asyncio.run(send_packets(client,SimpleNamespace(max_write_without_response_size=20),[bytes(200)]))
            self.assertEqual(client.write_gatt_char.call_count,1)
            sleep.assert_not_called()

    def test_white_paper_and_black_text_are_not_reversed(self):
        app_pixels = bytes([0x80,0x00,0xff]) + bytes(69)
        bitmap = list(raster_packets(576,1,app_pixels))[1][8:]
        # ESC/POS and the browser both use 1=black, 0=white.
        self.assertEqual(bitmap, app_pixels)

    def test_receipt_does_not_contain_label_or_repeat_commands(self):
        job = b''.join(raster_packets(576, 1, bytes(72)))
        for command in (b'SIZE ', b'GAP ', b'BITMAP ', b'PRINT ', b'CONTINUOUS', b'\x1dV'):
            self.assertNotIn(command, job)

    def test_builtin_sample_contains_real_bitmap(self):
        data = Path(__file__).with_name('printer-test.bin').read_bytes()
        self.assertEqual(len(data),576//8*240)
        self.assertTrue(any(data))
        self.assertTrue(any(byte == 0 for byte in data))

    def test_printer_reported_errors_are_not_treated_as_success(self):
        check_status(0x12)
        check_status(None)
        check_status(0)  # A TSPL-style zero is not an ESC/POS ready response.
        for status in (0x16,0x1a,0x32,0x52):
            with self.subTest(status=status), self.assertRaises(ValueError):
                check_status(status)
        check_status(0x1e, 4)  # Near-end alone is not paper-out.
        with self.assertRaisesRegex(ValueError, 'no paper'):
            check_status(0x72, 4)

    @patch('bluetooth_printer.PRINT_BLOCK_REASON', '')
    def test_worker_uses_bitmap_channel_and_blocks_printing_on_paper_error(self):
        for printer_status in (0x12,0x32):
            with self.subTest(printer_status=printer_status):
                writes = []
                characteristic = SimpleNamespace(properties=['write-without-response'],uuid=WRITE_UUID)
                status_characteristic = SimpleNamespace(properties=['notify'],uuid=STATUS_UUID)
                class FakeClient:
                    def __init__(self,*args,**kwargs):
                        self.services = SimpleNamespace(get_characteristic=lambda uuid: characteristic if uuid == WRITE_UUID else status_characteristic)
                    async def __aenter__(self): return self
                    async def __aexit__(self,*args): pass
                    async def start_notify(self,char,callback): self.callback = callback
                    async def write_gatt_char(self,char,data,response):
                        self_outer.assertEqual(char.uuid,WRITE_UUID)
                        self_outer.assertFalse(response)
                        if data in (b'\x10\x04\x02', b'\x10\x04\x04'):
                            self.callback(status_characteristic,bytes([printer_status if data[-1] == 2 else 0x12]))
                        else:
                            writes.append(data)
                self_outer = self
                device = SimpleNamespace(address='test-only',name='802-TSC')
                with patch.dict('sys.modules',{'bleak':SimpleNamespace(BleakClient=FakeClient)}), \
                     patch('bluetooth_printer.find_printer',new=AsyncMock(return_value=device)), \
                     patch('bluetooth_printer.asyncio.sleep',new=AsyncMock()):
                    request = {'action':'print','raster':{'width':576,'height':1,'data':base64.b64encode(bytes([0x80])+bytes(71)).decode()}}
                    if printer_status != 0x12:
                        with self.assertRaisesRegex(ValueError,'no paper'):
                            asyncio.run(worker(request))
                        self.assertEqual(writes,[])
                    else:
                        response = asyncio.run(worker(request))
                        self.assertEqual(response['status'],0x12)
                        job = b''.join(writes)
                        self.assertEqual(job, b''.join(raster_packets(576,1,bytes([0x80])+bytes(71))))
                        self.assertEqual(response['protocol'],'escpos')

    def test_invalid_images_are_rejected_before_bluetooth_access(self):
        for body in [{'width':575,'height':1,'data':''}, {'width':576,'height':True,'data':''},
                     {'width':576,'height':8001,'data':''}, {'width':576,'height':1,'data':'!!!'},
                     {'width':576,'height':1,'data':'AA=='}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_raster(body)

    @patch('bluetooth_printer.PRINT_BLOCK_REASON', '')
    @patch('bluetooth_printer.available',return_value=True)
    @patch('bluetooth_printer.subprocess.run',side_effect=subprocess.TimeoutExpired('print',180))
    def test_timeout_does_not_retry_and_releases_lock(self, run, available):
        with self.assertRaisesRegex(ValueError, 'Check the paper'):
            run_bridge('print',raster={'width':384,'height':1,'data':base64.b64encode(bytes(48)).decode()})
        self.assertEqual(run.call_count,1)
        self.assertFalse(PRINT_LOCK.locked())

    @patch('bluetooth_printer.PRINT_BLOCK_REASON', '')
    @patch('bluetooth_printer.available',return_value=True)
    @patch('bluetooth_printer.subprocess.run')
    def test_overlapping_jobs_are_rejected(self, run, available):
        PRINT_LOCK.acquire()
        try:
            with self.assertRaisesRegex(ValueError,'busy'):
                run_bridge('test')
            run.assert_not_called()
        finally:
            PRINT_LOCK.release()

    @patch('bluetooth_printer.PRINT_BLOCK_REASON', '')
    @patch('bluetooth_printer.available',return_value=True)
    @patch('bluetooth_printer.subprocess.run',return_value=subprocess.CompletedProcess('probe',0,'{"ok":false,"error":"Printer offline"}',''))
    def test_transport_failure_is_not_reported_as_success(self, run, available):
        with self.assertRaisesRegex(ValueError,'Printer offline'):
            run_bridge('test')


if __name__ == '__main__':
    unittest.main()
