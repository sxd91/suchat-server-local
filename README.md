# Suchat Server Local

SQLite-backed local API and administration server for Suchat. The server uses Node's built-in `node:sqlite` driver and creates its database under `data/suchat.db` on first run.

## Start

```powershell
Set-Location F:\suchat\suchat-server-local
.\server.bat
```

Default local URL: http://127.0.0.1:8787

## Configuration

Set `SUCHAT_ADMIN_HANDLE`, `SUCHAT_ADMIN_PASSWORD`, `SUCHAT_HOST`, `SUCHAT_PORT`, and `SUCHAT_JWT_SECRET` before starting to override defaults. Default local admin credentials are `admin` / `change-me`.

## API notes

All user routes except register/login send `Authorization: Bearer <accessToken>`. User registration and login return that token. Admin routes use the admin login cookie or an admin bearer token.

| Area | Routes |
| --- | --- |
| Service | `GET /api/v1/health`, `GET /api/v1/meta` |
| Authentication | `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET/PATCH /api/v1/me` |
| Preferences & devices | `GET/PUT /api/v1/me/appearance`, `GET/POST /api/v1/devices`, `DELETE /api/v1/devices/:id` |
| People & contacts | `GET /api/v1/users/search?q=`, `GET/POST /api/v1/contacts`, `DELETE /api/v1/contacts/:userId` |
| Conversations | `GET/POST /api/v1/conversations`, `GET/POST /api/v1/conversations/:id/messages` |
| Social | `GET/POST /api/v1/moments`, `DELETE /api/v1/moments/:id`, `GET/POST /api/v1/bottles`, `POST /api/v1/bottles/:id/pick` |
| Local upload metadata | `GET /api/v1/uploads`, `POST /api/v1/uploads/metadata` |
| Notifications & reports | `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read`, `POST /api/v1/reports` |
| Admin | `POST /api/admin/v1/auth/login`, `GET /api/admin/v1/dashboard`, `GET /api/admin/v1/users`, `GET/PATCH /api/admin/v1/reports`, `GET /api/admin/v1/system/status` |

The upload endpoint records metadata only; a storage transport can be connected later using its `storageKey` field. Generated database files, upload data, and `node_modules` are ignored by Git.

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

Then enter `http://YOUR_COMPUTER_IPV4:8787` on the Android setup screen. Android emulator endpoint: `http://10.0.2.2:8787`.
