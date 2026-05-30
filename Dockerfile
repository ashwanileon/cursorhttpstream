FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "index.js"]
