# MCP Buses Coruña

Wrapper MCP de la API iTranvias usada por la Compañía de Tranvías de A Coruña. Expone, sin priorizar ni ocultar paradas o líneas:

- el catálogo completo de líneas, rutas y paradas desde un snapshot local versionado;
- las llegadas en tiempo real de una parada indicada por su identificador (`func=0`).

Incluye una app embebida y puede ejecutarse mediante `stdio` o Streamable HTTP. No conserva la configuración funcional de la aplicación de la que procede: no hay parada principal, líneas de interés ni valores predeterminados de negocio.

En una ejecución normal, `list_bus_lines` y `search_stops` no acceden a iTranvias. El servidor carga el catálogo desde disco al arrancar y reserva la API externa para `show_bus_arrivals`. Así se evitan descargas repetidas de la estructura completa, se reduce la carga sobre el proveedor y las búsquedas siguen disponibles aunque la API esté temporalmente degradada.

## Requisitos y puesta en marcha

- Node.js 20.19 o posterior.
- Para una instalación reproducible, usa `npm ci` (no `npm install`).

```bash
npm ci
npm test
npm run build
npm run serve
```

El transporte predeterminado es `stdio`, apropiado para clientes MCP que ejecutan el proceso localmente. Solo las consultas de llegadas requieren acceso a red.

## Herramientas

- `list_bus_lines`: devuelve todas las líneas del catálogo local. Cada línea incluye `line_id`, `line_name`, `origin`, `destination`, `color_hex` y sus recorridos como `routes` (`route_id`, `origin`, `destination` y `stop_ids`).
- `search_stops`: devuelve el catálogo de paradas o lo filtra por nombre o identificador. `query` es opcional y `limit` admite valores entre 1 y 400.
- `show_bus_arrivals`: devuelve las llegadas de la parada indicada. `stopId` es obligatorio.

Las respuestas incluyen texto y `structuredContent`. Las tres herramientas incorporan `structuredContent.catalog`, con `schema_version`, `generated_at`, `line_count` y `stop_count`; así puede identificarse exactamente qué snapshot respalda el resultado. Una parada inexistente o un fallo del proveedor se devuelve como error de herramienta (`isError: true`).

## Catálogo local

El catálogo distribuido en `data/transit-catalog.json` contiene una copia normalizada de las líneas, rutas y paradas. Se versiona junto al código, se valida al arrancar y no se modifica durante la ejecución. Un cambio de red de transporte requiere actualizar ese archivo y desplegar la nueva versión, pero no cambiar el código ni la estructura del MCP.

Para usar otro snapshot compatible sin recompilar:

```bash
CATALOG_PATH=/ruta/al/transit-catalog.json npm run serve
```

`CATALOG_PATH` debe apuntar a un archivo con el mismo esquema normalizado. La fecha `generated_at` se publica como `structuredContent.catalog.generated_at` en las herramientas y como `generated_at` en `/health`, lo que permite detectar un despliegue desactualizado.

### Actualización manual

La actualización es una operación explícita de mantenimiento, nunca una tarea automática del servidor:

```bash
npm run update:catalog
npm test
```

El actualizador descarga mediante `func=7`, valida y normaliza la respuesta y sustituye el snapshot de forma atómica. Si la descarga o la validación falla, conserva intacto el catálogo anterior. Conviene revisar el diff —altas y bajas de líneas, rutas y paradas— antes de confirmar y desplegar el archivo.

El valor opaco `dato=20160101T000000_gl_0_20160101T000000` de la URL `func=7` es el parámetro que iTranvias requiere para solicitar el snapshot completo. La API real responde que los parámetros no son válidos si se omite. Por tanto, este valor forma parte del protocolo del proveedor y no expresa una fecha, parada, línea ni preferencia de negocio del MCP.

Variables exclusivas del actualizador:

| Variable | Predeterminado | Descripción |
| --- | --- | --- |
| `CATALOG_SOURCE_URL` | URL iTranvias `func=7` | Origen HTTP(S) usado por `npm run update:catalog` |
| `CATALOG_PATH` | `data/transit-catalog.json` | Destino del snapshot; también sirve como override del runtime |
| `CATALOG_TIMEOUT_SECONDS` | `20` | Tiempo máximo de descarga, entre 1 y 120 segundos |

`CATALOG_SOURCE_URL` y `CATALOG_TIMEOUT_SECONDS` no se leen en runtime. No configures una actualización periódica en cada instancia del MCP: hazla una sola vez, revisa el resultado y distribuye el snapshot validado.

## Llegadas y configuración del runtime

En runtime, la única operación remota es `func=0`. Puede dirigirse a un proxy o a otra instancia compatible mediante `ARRIVALS_URL_TEMPLATE`; el marcador `{stop_id}` es obligatorio.

iTranvias limita actualmente las consultas a una por segundo y cuatro por minuto. El servidor aplica esos límites por proceso, deduplica peticiones simultáneas de la misma parada y conserva una lectura fresca durante 15 segundos. Si el proveedor se bloquea temporalmente, puede entregar durante un máximo de 120 segundos la última lectura válida, marcada como `source: "stale"` y con su `fetched_at` original. Nunca recalcula ni inventa minutos.

| Variable | Predeterminado | Restricción |
| --- | --- | --- |
| `CATALOG_PATH` | `data/transit-catalog.json` | Snapshot local normalizado y legible |
| `ARRIVALS_URL_TEMPLATE` | `https://itranvias.com/queryitr_v3.php?func=0&dato={stop_id}` | URL HTTP(S) con `{stop_id}` |
| `HTTP_TIMEOUT_SECONDS` | `8` | Número entre 1 y 120 |
| `ARRIVALS_CACHE_TTL_SECONDS` | `15` | Tiempo durante el que se reutiliza una lectura válida, entre 0 y 300 |
| `ARRIVALS_STALE_TTL_SECONDS` | `120` | Antigüedad máxima de la última lectura utilizable, hasta 3600 segundos |
| `ITRANVIAS_MIN_INTERVAL_MS` | `1100` | Separación mínima entre peticiones externas |
| `ITRANVIAS_MAX_REQUESTS_PER_MINUTE` | `4` | Máximo global por proceso Node |

El widget no se actualiza automáticamente: consulta al seleccionar una parada y cuando la persona pulsa **Actualizar**. Esto evita que varias conversaciones agoten por sí solas el límite del proveedor. Si despliegas varios procesos o réplicas bajo una misma IP, coordina el límite en un proxy o almacenamiento compartido.

## Integración como aplicación de ChatGPT

La plantilla usa una URI versionada para evitar que ChatGPT conserve un bundle anterior. `search_stops` es una herramienta pública y no abre el widget; solo `show_bus_arrivals` está vinculada a la plantilla interactiva.

El recurso declara un CSP sin conexiones directas (`connectDomains` y `resourceDomains` vacíos), porque el bundle es autocontenido y accede al servidor exclusivamente mediante el puente MCP. El dominio del widget se configura como un origen, sin ruta:

| Variable | Predeterminado | Descripción |
| --- | --- | --- |
| `WIDGET_DOMAIN` | `https://escudero.gtec.udc.es` | Origen dedicado que ChatGPT asigna al widget |

Para publicar más de una aplicación, usa un subdominio diferente y con DNS/TLS para cada una, por ejemplo `https://buses-coruna.escudero.gtec.udc.es`. Tras cambiar HTML, CSS o JavaScript, incrementa la versión de `APP_RESOURCE_URI` en `server.ts` antes de volver a crear la versión de la aplicación en ChatGPT.

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
CATALOG_PATH=/opt/mcp-buses-coruna/data/transit-catalog.json
HTTP_TIMEOUT_SECONDS=8
WIDGET_DOMAIN=https://escudero.gtec.udc.es
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

Las pruebas de integración usan un catálogo temporal y una API de llegadas simulada para ejercitar el MCP completo por `stdio`: descubrimiento, recurso UI, metadata del snapshot, catálogo sin priorización, búsqueda, orden de llegadas y errores. También verifican que ninguna llamada normal intenta descargar `func=7`.
