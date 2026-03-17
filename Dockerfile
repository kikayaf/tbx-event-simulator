FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "start:api"]
