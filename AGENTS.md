# Guía operativa

## Runtime y comandos

- Usa Node.js 20.19 o posterior y ejecuta los comandos desde esta carpeta.
- Instalación reproducible: `npm ci`.
- Verificación completa: `npm test`.
- Build de producción: `npm run build`.
- Smoke HTTP, con el servidor ya iniciado: `./scripts/test-mcp-connection.sh`.

## Contratos que deben preservarse

- El transporte predeterminado es `stdio`; no escribas logs en stdout.
- El endpoint HTTP MCP es `/mcp` y el healthcheck es `/health`.
- Los datos externos son no confiables: valida el esquema antes de cachearlos y no los insertes con `innerHTML`.
- Los fallos de herramienta deben devolver `isError: true`; no sustituyas fallos de la API por datos ficticios cacheables.
- Mantén una sola caché de catálogo por proceso y deduplica cargas simultáneas.
- El recurso UI servido debe ser exclusivamente el bundle `dist/mcp-app.html`.

## Pruebas

- Las pruebas de integración usan una API iTranvias simulada: no deben depender de red pública.
- Si cambias herramientas, contenido estructurado, filtrado o caché, actualiza `tests/stdio.integration.test.mjs`.
- Si cambias seguridad, cabeceras o transporte HTTP, actualiza también `scripts/test-mcp-connection.sh`.
