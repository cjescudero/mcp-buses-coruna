# MCP Buses Coruña

Servidor MCP con una app embebida para consultar paradas y llegadas de los buses urbanos de A Coruña. Obtiene el catálogo y las llegadas de iTranvias, filtra las líneas configuradas y ofrece transporte local `stdio` o Streamable HTTP.

## Requisitos y puesta en marcha

- Node.js 20.19 o posterior.
- Para una instalación reproducible, usa `npm ci` (no `npm install`).

```bash
npm ci
npm test
npm run build
npm run serve
```

El transporte predeterminado es `stdio`, apropiado para clientes MCP que ejecutan el proceso localmente. No requiere acceso a red salvo para consultar iTranvias.

## Herramientas

- `show_bus_arrivals`: llegadas de `stopId`, o de la parada principal si se omite.
- `show_default_bus_arrivals`: llegadas de la parada principal.
- `search_stops`: busca paradas por nombre, con un límite entre 1 y 400.

Las respuestas incluyen texto y `structuredContent`. Una parada inexistente o un fallo del proveedor se devuelve como error de herramienta (`isError: true`).

## Configuración de tránsito

La configuración funcional se lee del primer archivo existente:

1. `APP_CONFIG_PATH`.
2. `config/app_config.json`.
3. `../busesyparadas/config/app_config.json`.
4. `busesyparadas/config/app_config.json`.

Ejemplo:

```json
{
  "primary_stop_id": 42,
  "interest_lines": ["3", "3A", "12", "14"]
}
```

Variables opcionales:

| Variable | Predeterminado | Restricción |
| --- | --- | --- |
| `STOPS_SOURCE_URL` | URL de iTranvias `func=7` | URL HTTP(S) válida |
| `ARRIVALS_URL_TEMPLATE` | URL de iTranvias `func=0` | URL HTTP(S) con `{stop_id}` |
| `CACHE_TTL_SECONDS` | `300` | Entero no negativo; `0` desactiva la caché |
| `HTTP_TIMEOUT_SECONDS` | `8` | Número entre 1 y 120 |

El catálogo se valida antes de entrar en caché. Si el proveedor falla, el servidor no crea ni conserva paradas ficticias.

## Transporte HTTP

```bash
MCP_TRANSPORT=http npm run serve
```

- MCP: `http://127.0.0.1:3001/mcp`
- Healthcheck: `http://127.0.0.1:3001/health`

Configuración HTTP:

| Variable | Predeterminado | Descripción |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interfaz de escucha; usa `0.0.0.0` solo tras un proxy o aislamiento adecuado |
| `PORT` | `3001` | Puerto TCP válido |
| `MCP_ALLOWED_ORIGINS` | Orígenes loopback | Lista CSV de orígenes permitidos |
| `MCP_ALLOWED_HOSTS` | Hosts loopback y `HOST` | Lista CSV de valores `Host` permitidos |
| `MCP_AUTH_TOKEN` | sin token | Si se define, `/mcp` exige `Authorization: Bearer …` |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` | Límite por IP; `0` lo desactiva |

El servidor valida `Origin` y `Host` para reducir el riesgo de DNS rebinding. No uses CORS abierto en producción. Si expones el MCP fuera del equipo, configura TLS en el proxy, un token fuerte, los orígenes y hosts exactos, y conserva el rate limit.

### Smoke test HTTP

Con el servidor HTTP iniciado:

```bash
./scripts/test-mcp-connection.sh
```

El script comprueba `/health` y envía una petición MCP `initialize` real a `/mcp`. Para otro destino o un servidor protegido:

```bash
BASE_URL=https://mcp.example.org \
ORIGIN=https://cliente.example.org \
MCP_AUTH_TOKEN='token-secreto' \
./scripts/test-mcp-connection.sh
```

## Despliegue con systemd y Nginx

Instala y compila la aplicación, por ejemplo, en `/opt/mcp-buses-coruna`:

```bash
cd /opt/mcp-buses-coruna
npm ci
npm test
npm run build
```

Archivo `/etc/mcp-buses-coruna.env`:

```dotenv
MCP_TRANSPORT=http
HOST=127.0.0.1
PORT=3001
APP_CONFIG_PATH=/opt/mcp-buses-coruna/config/app_config.json
CACHE_TTL_SECONDS=300
HTTP_TIMEOUT_SECONDS=8
MCP_ALLOWED_ORIGINS=https://cliente.example.org
MCP_ALLOWED_HOSTS=mcp.example.org
MCP_AUTH_TOKEN=cambia-este-token
MCP_RATE_LIMIT_PER_MINUTE=120
```

Protege ese archivo porque contiene el token:

```bash
sudo chown root:root /etc/mcp-buses-coruna.env
sudo chmod 600 /etc/mcp-buses-coruna.env
```

Unidad `/etc/systemd/system/mcp-buses-coruna.service`:

```ini
[Unit]
Description=MCP Buses Coruña
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mcp-buses-coruna
EnvironmentFile=/etc/mcp-buses-coruna.env
ExecStart=/usr/bin/npm run serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Proxy Nginx con TLS ya configurado:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.org;

    location = /mcp {
        proxy_pass http://127.0.0.1:3001/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_set_header Host $host;
    }
}
```

Tras instalar o actualizar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-buses-coruna
sudo systemctl status mcp-buses-coruna
journalctl -u mcp-buses-coruna -f
```

La URL que debe usar un cliente remoto es `https://mcp.example.org/mcp`. No uses `localhost` desde una máquina distinta al servidor.

## Desarrollo y verificación

```bash
npm run build:app       # bundle único de la app MCP
npm run build:server    # TypeScript del servidor
npm run build           # ambos
npm test                # build y pruebas sin depender de la red pública
```

Las pruebas de integración arrancan una API iTranvias simulada y ejercitan el MCP completo por `stdio`: descubrimiento, recurso UI, búsqueda, filtrado, orden de llegadas, errores y reutilización de caché.
