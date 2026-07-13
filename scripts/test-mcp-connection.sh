#!/usr/bin/env bash
# Smoke test HTTP: comprueba health e inicializa una sesión MCP real.

set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
HEALTH_URL="${BASE_URL}/health"
MCP_URL="${BASE_URL}/mcp"
ORIGIN="${ORIGIN:-${BASE_URL}}"

echo "Probando servidor MCP Buses Coruña"
echo "  Health: $HEALTH_URL"
echo "  MCP:    $MCP_URL"
echo ""

if ! response=$(curl -fsS --max-time 5 "$HEALTH_URL"); then
  echo "ERROR: No se pudo conectar a $HEALTH_URL"
  echo "  - ¿Está el servicio mcp-buses-coruna en marcha? (systemctl status mcp-buses-coruna)"
  echo "  - ¿Escucha en el puerto configurado? (por defecto, 3001)"
  exit 1
fi

if ! echo "$response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "ERROR: Respuesta inesperada de health: $response"
  exit 1
fi

echo "OK: Health respondió: $response"

initialize_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-http-smoke-test","version":"1.0.0"}}}'
curl_mcp() {
  if [[ -n "${MCP_AUTH_TOKEN:-}" ]]; then
    curl -fsS --max-time 10 -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "Origin: ${ORIGIN}" \
      -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" \
      --data "$initialize_payload"
  else
    curl -fsS --max-time 10 -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "Origin: ${ORIGIN}" \
      --data "$initialize_payload"
  fi
}

if ! mcp_response=$(curl_mcp); then
  echo "ERROR: /mcp no aceptó la petición initialize"
  exit 1
fi

if ! echo "$mcp_response" | grep -q '"serverInfo"'; then
  echo "ERROR: /mcp devolvió una respuesta que no parece una inicialización MCP: $mcp_response"
  exit 1
fi

echo "OK: /mcp completó initialize"
echo "URL para el cliente MCP: $MCP_URL"
