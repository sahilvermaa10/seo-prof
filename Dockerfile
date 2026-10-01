# Single container: Node web app + Python SEO engine (Node auto-starts the engine on :8000).
# Build:  docker build -t seo-agent .
# Run:    docker run -p 3000:3000 --env-file .env seo-agent
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY seo-engine/requirements.txt seo-engine/requirements.txt
RUN python3 -m venv seo-engine/venv \
 && seo-engine/venv/bin/pip install --no-cache-dir -r seo-engine/requirements.txt

COPY . .
ENV NODE_ENV=production PORT=3000 PYTHON_BIN=/app/seo-engine/venv/bin/python
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
