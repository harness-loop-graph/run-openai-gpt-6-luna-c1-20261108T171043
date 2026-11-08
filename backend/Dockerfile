FROM node:22.12-alpine3.20
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5.7.2 && npm run build
EXPOSE 3000
CMD ["npm", "start"]
