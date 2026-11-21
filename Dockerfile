# Versão fixa do Node. A imagem "node:slim" sem versão pegava a última Node
# (26 hoje em produção) e mudava a base do Debian sem aviso.
FROM node:22-slim

# O Puppeteer não baixa o Chromium dele; usamos o Chrome estável do Google.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# apt-key foi removido no Debian 13 (trixie). A chave do repositório do
# Chrome vai para /etc/apt/keyrings e é referenciada via signed-by.
# tini: reaproveita os processos-filho do Chrome (evita processos zumbis).
# tzdata: datas do DARE no fuso de Rondônia.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tini tzdata \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl --fail --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub \
    -o /etc/apt/keyrings/google-chrome.asc \
    && chmod 0644 /etc/apt/keyrings/google-chrome.asc \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Sem isso o container roda em UTC: depois das 20h em RO o vencimento e o
# mês de referência eram calculados como se já fosse o dia seguinte.
ENV TZ=America/Porto_Velho \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production \
    PORT=8080

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
