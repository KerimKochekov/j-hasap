# j-hasap

A local point-of-sale app for Turkmenistan manat (TMT). Built with Python, SQLite, and browser JavaScript. The main app needs no Python packages, cloud account, or internet connection after installation. Supports English, Türkmençe, and Русский.

## Installation

### Requirements

- Python **3.9 or newer** for the main app; **3.10 or newer** for optional Bluetooth printing.
- A modern browser such as Chrome, Edge, Firefox, or Safari.
- Git to clone this repository, or use **Code → Download ZIP** on GitHub and extract it.
- For browser printing, an installed printer driver and printer queue.

Install Python from [python.org](https://www.python.org/downloads/) if it is not already installed. On Windows, enable **Add Python to PATH** during installation.

### macOS / Linux

```sh
git clone https://github.com/KerimKochekov/j-hasap.git
cd j-hasap
python3 server.py
```

### Windows

```powershell
git clone https://github.com/KerimKochekov/j-hasap.git
cd j-hasap
py -3 server.py
```

If `py` is unavailable, use `python server.py`.

Open [http://127.0.0.1:8765](http://127.0.0.1:8765) in your browser. Keep the terminal running while using the app. Stop it with **Ctrl+C**. On macOS, you can also double-click `Start POS.command` after installing Python. If needed, run `chmod +x "Start POS.command"` to make the launcher executable.

On first startup, the app creates `data/pos.sqlite3` and an empty product catalog. Add products through **Products → Add product**. Bundled product illustrations are included; your local products and sales database are not included in this repository.

### Optional BT-802 Bluetooth printing (macOS only)

The direct Bluetooth transport uses macOS CoreBluetooth and is not implemented for Windows or Linux. Browser printing works on all three platforms with an installed printer.

With Python 3.10 or newer, run these commands inside the project folder:

```sh
python3 -m venv .venv-printer
.venv-printer/bin/python -m pip install -r requirements-printer.txt
.venv-printer/bin/python server.py
```

Turn on the BT-802 and allow Bluetooth access for the application running the server, such as Terminal, when macOS asks. You can also enable it under **System Settings → Privacy & Security → Bluetooth**.

Click **Print receipt**, **Print barcode**, or **Print sample** and choose **BT-802 Bluetooth**. Selecting it checks the printer connection without printing paper. Print stays disabled when the check fails; use **Check connection** to retry. Run a short test from **Receipt designer → Printer connection → Print Bluetooth test** before relying on receipt output.

The supported device's self-test reports `CMD Type: ESC` despite its Bluetooth name `802-TSC`. This implementation uses ESC/POS, not TSPL label commands. Other BT-802 firmware variants may differ. Direct BLE transfer and a normal status reply do not guarantee correct physical output. Receipts use a 576-dot / 72 mm print head on an 80 mm roll, or 384-dot images for 58 mm layouts. Long Bluetooth jobs can take several minutes; images are limited to 8,000 dots. Failed jobs never retry automatically.

## Using the app

- **Products:** add a name, barcode, price, available quantity, and optional picture. Generate a barcode if needed. Pictures accept PNG, JPEG, or WebP up to 400 KB; the default picture is a dress. Archive products to remove them from the active catalog while preserving their sales history.
- **Checkout:** click a product or scan its barcode. Configure your scanner in keyboard mode with an Enter suffix. Available stock is visible; basket quantities cannot exceed it. Enter the payment method and cash received, then click **Complete sale**. Stock is deducted only after a successful sale. Failed sales leave it unchanged.
- **Optional receipts:** completing a sale opens a receipt preview but never automatically prints. Click **Print receipt** when needed.
- **Printer choice:** receipts, product barcode labels, and samples share a printer-choice dialog. Browser printing opens the system print dialog; Bluetooth printing first checks the BT-802 connection.
- **Product history:** click a product picture or name on Products to see its price timeline, sold dates and quantities, sold unit prices, receipt links, current stock, units sold, and revenue. Price changes are recorded from the time tracking starts; earlier unrecorded price edits cannot be recovered. Existing saved sales are included.
- **Sales history:** view and reprint completed transactions. Sale records preserve product names and prices as they were at purchase time.
- **Statistics:** view revenue, transactions, units sold, average sale, daily revenue, and top products for a date range.
- **Languages:** use the sidebar selector. Custom product names and custom receipt text remain as entered. Dates follow the computer's local timezone.

For browser printing, select the correct printer and paper size, disable headers/footers, use 100% scale, and choose minimum margins. Barcode labels use Code 39, require compatible scanner settings, and are limited to 18 characters for the narrow layout. The app does not silently print or control a cash drawer.

## Receipt designer

Open **Receipt designer** to customize store text, address, logo, alignment, fonts, sizes, dividers, spacing, payment details, receipt barcodes, and Instagram QR codes. QR codes are generated locally. Enter your own full Instagram link and check it by scanning the preview.

Choose 58, 72, or 80 mm paper and match the printer settings. **Print sample** uses the current draft without recording a sale. **Save design** applies the design to new sales. Completed sales retain a snapshot of their original receipt design, including when reprinted. Unsaved changes are lost on page reload.

## Data, backups, and updates

All local records, stock, price history, receipt settings, and uploaded pictures are stored in `data/pos.sqlite3`. Clearing browser storage does not delete them. The database, backups, and local environments are excluded from Git.

**Back up:** stop the server and copy `data/pos.sqlite3` to a safe location. **Restore:** stop the server and replace that file with your backup. Keep regular backups.

**Update:** stop the server, back up the database, run `git pull`, then restart the server and refresh the browser. Startup automatically applies database migrations without resetting existing sales or stock. If dependencies changed, rerun the optional printer installation command.

### Custom port or database

```sh
python3 server.py --port 8766 --database data/second-shop.sqlite3
```

On Windows, substitute `py -3` for `python3`. Open the matching local port. The server binds to `127.0.0.1` and is intended for one operator on one computer.

## Troubleshooting

- **Cannot open the app:** keep the server running and use the exact localhost address. If port 8765 is occupied, choose another port using `--port`.
- **Python command not found:** install Python and reopen the terminal. On Windows, try `py -3`.
- **Bluetooth option unavailable:** install `.venv-printer` using Python 3.10+ on macOS and restart the server.
- **BT-802 not responding:** turn it on, check Bluetooth permissions, and retry Check connection.
- **Blank paper:** check that the thermal-coated side faces the print head. Scratch both sides to identify the coating; it should darken. The supplied BT-802 manual describes a self-test: with the printer off, hold FEED and then hold POWER for about two seconds.
- **Continuous blank feeding:** switch the printer off to stop it. Verify its self-test command type and paper mode before trying again. This app uses ESC/POS receipt commands; do not use TSPL jobs on a device in ESC mode.
- **A print fails:** inspect the paper before retrying, because part of the job may already have printed. Do not disable paper/cover sensors or the error buzzer.

## Development and tests

Run from the project folder:

```sh
python3 -m unittest -v
```

Optional JavaScript checks require Node.js:

```sh
node --check app.js
node --check bluetooth-print.js
node test_i18n.js
```

On Windows, use `py -3 -m unittest -v`. If `test_i18n.js` cannot find `python3`, set `POS_TEST_PYTHON` to your Python executable path. Tests use temporary databases and do not alter live sales or print physical jobs.

## Scope

Includes local inventory, price history, sales, receipt design, and reporting. Does not include taxes, discounts, refunds, staff accounts, multi-terminal operation, or fiscal receipt certification. Receipts are ordinary sales records. The app is intended for a trusted local operator.

## Third-party libraries

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), bundled in `vendor-qrcode.js`; see `LICENSE-qrcode.txt`.
- [html2canvas](https://github.com/niklasvh/html2canvas), bundled in `vendor-html2canvas.js`; see `LICENSE-html2canvas.txt`.
- [Bleak](https://github.com/hbldh/bleak), installed only for optional Bluetooth printing; see `requirements-printer.txt`.

### Barcode designer

Open **Barcode designer** to customize product labels with the same block editor as receipts. Choose a preview product, change the paper width, font, block order and text, then click **Save design**. Product name, Code 39 barcode and price come from the catalog. The saved label layout is used by **Print barcode** on the Products page. **Print sample** offers browser or BT-802 printing with a Bluetooth connection check. Barcode and receipt designs are saved separately.

### Discounts and quantity history

Checkout has one **Discount (%)** field that applies to all products. Each discounted unit price is rounded to cents and saved with the sale, so receipts, sales history and revenue keep the sold prices after catalog edits.

For existing products, choose **Add quantity** or **Remove quantity**, enter the quantity and an optional description, then **Save product**. Product history shows additions in green and removals, including sales, in red. Sales log quantities show positive units sold.
