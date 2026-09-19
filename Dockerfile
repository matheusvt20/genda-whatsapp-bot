FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

CMD ["npm", "start"]
