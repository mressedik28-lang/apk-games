FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY scripts ./scripts
COPY public ./public
COPY downloads ./downloads
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
