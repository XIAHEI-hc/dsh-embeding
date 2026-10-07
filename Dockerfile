FROM node:24-bookworm-slim AS official-web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/workbench-extensions ./packages/workbench-extensions
COPY packages/probe-data-tools ./packages/probe-data-tools
COPY vendor/official-web-forks ./vendor/official-web-forks
RUN npm ci --omit=dev --no-audit --no-fund && npm install --global pnpm@10.12.1

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates nginx libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=official-web /usr/local/ /usr/local/
COPY --from=official-web /app/node_modules /app/node_modules
WORKDIR /app
COPY package.json package-lock.json pyproject.toml constraints.txt ./
COPY packages/workbench-extensions ./packages/workbench-extensions
COPY packages/probe-data-tools ./packages/probe-data-tools
COPY vendor/official-web-forks ./vendor/official-web-forks
COPY workbench ./workbench
COPY vendor/official-sdk ./vendor/official-sdk
RUN pip install -c constraints.txt --no-cache-dir ./vendor/official-sdk/*.whl .
RUN useradd -m -u 10001 workbench && mkdir /data && chown workbench:workbench /data
USER workbench
ENV WORKBENCH_DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "-m", "workbench.cli", "web", "--host", "0.0.0.0", "--port", "8765"]
