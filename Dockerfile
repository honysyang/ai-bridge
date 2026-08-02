FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-bin-links --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY docs ./docs

ENV PORT=4567 \
    AIBRIDGE_DATA_DIR=/app/data

VOLUME ["/app/data"]
EXPOSE 4567

CMD ["node", "src/index.js"]
