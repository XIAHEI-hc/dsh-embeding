FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml constraints.txt ./
COPY workbench ./workbench
COPY vendor/official-sdk ./vendor/official-sdk
RUN pip install -c constraints.txt --no-cache-dir ./vendor/official-sdk/*.whl .
RUN useradd -m -u 10001 workbench && mkdir /data && chown workbench:workbench /data
USER workbench
ENV WORKBENCH_DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "-m", "workbench.cli", "web", "--host", "0.0.0.0", "--port", "8765"]
