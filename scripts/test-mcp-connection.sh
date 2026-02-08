#!/usr/bin/env bash
# Prueba rápida de que el servidor MCP responde.
# Uso:
#   ./scripts/test-mcp-connection.sh
#   BASE_URL=http://escudero.gtec.udc.es ./scripts/test-mcp-connection.sh

set -e
BASE_URL="${BASE_URL:-http://127.0.0.1:3004}"
HEALTH_URL="${BASE_URL}/health"
MCP_URL="${BASE_URL}/mcp"

echo "Probando servidor MCP Buses Coruña"
echo "  Health: $HEALTH_URL"
echo "  MCP:    $MCP_URL"
echo ""

if ! response=$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null); then
  echo "ERROR: No se pudo conectar a $HEALTH_URL"
  echo "  - ¿Está el servicio mcp-buses-coruna en marcha? (systemctl status mcp-buses-coruna)"
  echo "  - ¿Escucha en el puerto correcto? (ss -tlnp | grep 3004)"
  exit 1
fi

if echo "$response" | grep -q '"status":"ok"'; then
  echo "OK: Health respondió: $response"
  echo ""
  echo "Para el cliente MCP (Cursor, etc.) usa esta URL: $MCP_URL"
  exit 0
else
  echo "ERROR: Respuesta inesperada de health: $response"
  exit 1
fi
