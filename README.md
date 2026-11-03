# FORM & FADE

A small salon and barbershop website with service detail pages, appointment requests, and a password-protected admin dashboard. It runs on Node.js and stores bookings in a local JSON file; it does not require third-party packages or a separate database server.

## Run locally

Use Node.js 18 or newer. The default local admin login is username `ADMIN` and password `Admin123!`. In PowerShell, from this folder:

```powershell
$env:ADMIN_USERNAME = "ADMIN"
$env:ADMIN_PASSWORD = "choose-a-long-private-password"
npm start
```

Open [http://localhost:4173](http://localhost:4173) for the website and [http://localhost:4173/admin](http://localhost:4173/admin) for the dashboard. If either environment variable is omitted, the corresponding default is used. Change the default password before exposing the server to a network.

The home page links to a standalone service catalog at [http://localhost:4173/services.html](http://localhost:4173/services.html); each service opens its own detail page. Booking records are saved to `data/bookings.json`. Admin-entered collections, debts, and customer credits are saved separately to `data/transactions.json`. The `data` directory is created automatically and excluded from Git. Ledger entries are manual records, not payment processing. The dashboard checks for new transactions every 30 seconds; optional browser notifications can be enabled while the dashboard is open. Edit `services.json` to change service descriptions and KSh prices.

The included shop address, phone, team, hours, and prices are sample content. Set a strong admin password and replace those details before deploying. For a public production deployment, use HTTPS and a managed database rather than local JSON storage.
