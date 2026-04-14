FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g supergateway @xeroapi/xero-mcp-server

WORKDIR /app

COPY entrypoint.sh entrypoint.mjs /app/
RUN chmod +x /app/entrypoint.sh

USER node
EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
