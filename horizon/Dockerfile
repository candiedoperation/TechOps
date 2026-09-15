FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PHI_ENV_FILE="" PHI_ENVIRONMENT=production PHI_SQLITE_PATH=/var/lib/horizon/horizon.db
WORKDIR /app
COPY pyproject.toml requirements.lock ./
COPY backend ./backend
COPY scripts ./scripts
COPY run_pipeline.py build_member_profiles.py load_postgres.py schema.sql ./
COPY fixtures ./fixtures
COPY index.html app.js styles.css ./
COPY assets ./assets
COPY analytics ./analytics
COPY profiles ./profiles
RUN chmod -R a+rX /app && pip install --no-cache-dir -c requirements.lock '.[llm,pipeline]' && useradd --create-home --uid 10001 horizon && mkdir -p /var/lib/horizon /app/data && chown -R horizon:horizon /var/lib/horizon /app/data
USER horizon
EXPOSE 8000
CMD ["sh", "-c", "exec python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
