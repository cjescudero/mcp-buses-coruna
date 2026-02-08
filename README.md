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

## Probar la conexión

Si el cliente MCP no conecta, comprueba en este orden:

### 1. Que el servicio esté levantado y escuche en el puerto correcto

El servicio systemd usa `PORT=3004` por defecto en `deploy/mcp-buses-coruna.service`. Nginx debe hacer proxy al **mismo puerto** (en `deploy/nginx-mcp-buses-coruna.conf` está configurado `proxy_pass http://127.0.0.1:3004`).

```bash
# Estado del servicio
sudo systemctl status mcp-buses-coruna

# Ver en qué puerto escucha (debe ser 3004 si PORT=3004)
ss -tlnp | grep 3004
# o
curl -s http://127.0.0.1:3004/health
```

### 2. Script de prueba (recomendado)

Desde el repo:

```bash
./scripts/test-mcp-connection.sh
```

Para probar vía Nginx (sustituye por tu dominio):

```bash
BASE_URL=http://escudero.gtec.udc.es ./scripts/test-mcp-connection.sh
```

### 3. Health con curl

Sustituye `escudero.gtec.udc.es` por tu `server_name` si es distinto:

```bash
curl -s http://escudero.gtec.udc.es/health
# Debe devolver: {"status":"ok","transport":"streamable-http"}
```

Si falla aquí, revisa: Nginx activo, sitio habilitado, y que el backend responda en 3004.

### 4. URL para el cliente MCP (Cursor, Claude, etc.)

- **Tras Nginx:** `http://escudero.gtec.udc.es/mcp` (o `https://...` si tienes TLS).
- **Local (sin Nginx):** `http://localhost:3004/mcp`.

En Cursor: *Settings → MCP → Add server* (o editar `~/.cursor/mcp.json`). Ejemplo de entrada para transporte HTTP:

```json
{
  "mcpServers": {
    "buses-coruna": {
      "url": "http://escudero.gtec.udc.es/mcp"
    }
  }
}
```

Si el servidor está en otra máquina, usa la URL pública (con `https://` en producción). No uses `localhost` en el cliente si el servidor corre en otro host.

### 5. Logs del servidor

```bash
journalctl -u mcp-buses-coruna -f
```

Al conectar el cliente deberías ver peticiones en el log. Si no aparece nada, el cliente no está llegando al backend (firewall, URL errónea o Nginx).

---

## Configuración del cliente MCP

### Endpoint MCP (genérico)

Cuando se expone por Nginx:

`https://mcp.tudominio.com/mcp`

En local para pruebas (puerto por defecto del README, 3001; en el servicio de deploy se usa 3004):

`http://localhost:3001/mcp` o `http://localhost:3004/mcp` según tu `PORT`.

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
