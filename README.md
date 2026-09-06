# Suchat Server Local

Local Suchat API and administration server.

## Start

```powershell
Set-Location F:\suchat\suchat-server-local
.\server.bat
```

Default local URL: http://127.0.0.1:8787

## LAN access from an Android phone

Start on all network interfaces:

```powershell
$env:SUCHAT_HOST = "0.0.0.0"
.\server.bat
```

Find the computer IPv4 address:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike "127.*"}
```

Then enter `http://YOUR_COMPUTER_IPV4:8787` on the Android setup screen. Allow TCP 8787 or Node.js through Windows Firewall on Private networks.

Android emulator endpoint: `http://10.0.2.2:8787`.

## Routes

- Health: `/api/v1/health`
- Server metadata: `/api/v1/meta`
- Admin web: `/admin`
- Admin default credentials: `admin` / `change-me`

Set `SUCHAT_ADMIN_HANDLE`, `SUCHAT_ADMIN_PASSWORD`, `SUCHAT_HOST`, `SUCHAT_PORT`, and `SUCHAT_JWT_SECRET` before starting to override defaults.
