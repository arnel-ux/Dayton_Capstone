# CQA admin portal: Node/Express plus the Python (Flask) AI model server that
# server.js spawns as a child process, so both runtimes live in one image.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# server.js calls spawn('python', ...) on Linux; the venv's bin/ is first on
# PATH so that resolves to an interpreter with flask/google-genai installed.
COPY ai_scripts/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
# data/ (landing-page JSON) and public/images/uploads/ are written at runtime;
# compose mounts volumes there, which inherit this ownership.
RUN mkdir -p data public/images/uploads/profiles \
    && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["node", "server.js"]
