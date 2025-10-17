FROM node:22-alpine

ENV PYTHONUNBUFFERED=1
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN apk add --update --no-cache \
        ffmpeg \
        python3 \
        py3-pip \
    && ln -sf python3 /usr/bin/python

RUN python3 -m pip install --no-cache --upgrade pip setuptools

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --production

COPY src ./src
COPY .env.example ./

RUN mkdir -p logs

CMD ["node", "src/index.js"]
