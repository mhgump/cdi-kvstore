FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production --no-audit --silent
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
