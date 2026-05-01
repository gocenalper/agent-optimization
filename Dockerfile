FROM node:22-alpine
WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js analysis.js actuators.js pricing.js llm-analysis.js ./
COPY public/ public/

EXPOSE 4317
CMD ["node", "server.js"]
