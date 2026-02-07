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
