# MCP Buses Coruña

MCP App (tool + UI) que replica la lógica de `busesyparadas`:

- Catálogo de paradas desde `func=7`.
- Llegadas por parada desde `func=0&dato={stop_id}`.
- Filtrado por líneas de interés (`interest_lines`) y parada principal (`primary_stop_id`).
- Vista con buscador, buses más próximos y resto de llegadas.

## Configuración

Por defecto intenta leer `app_config.json` en este orden:

1. `APP_CONFIG_PATH` (si está definido)
2. `config/app_config.json`
3. `../busesyparadas/config/app_config.json`
4. `busesyparadas/config/app_config.json`

Variables opcionales:

- `STOPS_SOURCE_URL`
- `ARRIVALS_URL_TEMPLATE`
- `CACHE_TTL_SECONDS`
- `HTTP_TIMEOUT_SECONDS`
- `MCP_TRANSPORT` (`stdio` por defecto, o `http`)
- `PORT` (cuando `MCP_TRANSPORT=http`, por defecto `3001`)

## Ejecutar

```bash
npm install
npm run build
npm run serve
```

En `stdio` se comporta como servidor MCP para hosts locales.

Para HTTP:

```bash
MCP_TRANSPORT=http npm run serve
```

Endpoint MCP: `http://localhost:3001/mcp`

## Despliegue en Ubuntu como servicio (systemd) + Nginx

### 1) Preparar aplicación en servidor

```bash
sudo mkdir -p /opt/mcp-buses-coruna
sudo chown -R $USER:$USER /opt/mcp-buses-coruna
cd /opt/mcp-buses-coruna
git clone <REPO_URL> .
npm ci
npm run build
```

### 2) Archivo de entorno

Crear `/etc/mcp-buses-coruna.env`:

```bash
MCP_TRANSPORT=http
PORT=3001
APP_CONFIG_PATH=/opt/mcp-buses-coruna/config/app_config.json
CACHE_TTL_SECONDS=30
HTTP_TIMEOUT_SECONDS=10
```

### 3) Servicio systemd

Crear `/etc/systemd/system/mcp-buses-coruna.service`:

```ini
[Unit]
Description=MCP Buses Coruña (Streamable HTTP)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mcp-buses-coruna
EnvironmentFile=/etc/mcp-buses-coruna.env
ExecStart=/usr/bin/npm run serve
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Activar y arrancar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-buses-coruna
sudo systemctl status mcp-buses-coruna
```

Logs:

```bash
journalctl -u mcp-buses-coruna -f
```

### 4) Reverse proxy con Nginx

Ejemplo `/etc/nginx/sites-available/mcp-buses-coruna.conf`:

```nginx
server {
    listen 80;
    server_name mcp.tudominio.com;

    location /mcp {
        proxy_pass http://127.0.0.1:3001/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

Habilitar sitio:

```bash
sudo ln -s /etc/nginx/sites-available/mcp-buses-coruna.conf /etc/nginx/sites-enabled/mcp-buses-coruna.conf
sudo nginx -t
sudo systemctl reload nginx
```

Para producción, añadir TLS (por ejemplo con Let's Encrypt) y usar `https://`.

## Configuración del cliente MCP

### Endpoint MCP (genérico)

Cuando se expone por Nginx:

`https://mcp.tudominio.com/mcp`

En local para pruebas:

`http://localhost:3001/mcp`

Healthcheck opcional:

`GET /health`

### Tools incluidas

1. `show_bus_arrivals`
- Descripción: devuelve llegadas para una parada (o la principal configurada).
- Input:
  - `stopId` (number, opcional): ID de parada.
- Output: resumen en texto + `structuredContent` con `stop`, `arrivals`, `primaryStopId`.

2. `show_default_bus_arrivals`
- Descripción: devuelve llegadas de la parada principal configurada, sin requerir parámetros.
- Input: sin parámetros.
- Output: resumen en texto + `structuredContent` con `stop`, `arrivals`, `primaryStopId`.

3. `search_stops`
- Descripción: busca paradas filtradas por líneas de interés.
- Input:
  - `query` (string, opcional): texto de búsqueda.
  - `limit` (number, opcional, 1..400): máximo de resultados (por defecto 50).
- Output: texto con total + `structuredContent` con `stops`, `total`, `primaryStopId`.
