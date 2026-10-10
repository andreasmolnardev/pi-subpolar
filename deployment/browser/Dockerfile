FROM oven/bun:1.3.14
WORKDIR /worker
# Copy only the portable package: no workspace, home, or application credentials.
COPY packages/subpolar-browser/package.json ./package.json
RUN bun install --production
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
RUN bunx --no-install playwright install --with-deps chromium \
    && useradd --create-home --uid 10001 browser \
    && mkdir /profiles \
    && chown browser:browser /profiles /worker
COPY --chown=browser:browser packages/subpolar-browser/src ./src
USER browser
ENV SUBPOLAR_BROWSER_PROFILE_ROOT=/profiles
ENV SUBPOLAR_BROWSER_WORKER_HOST=0.0.0.0
EXPOSE 3101
CMD ["bun", "src/worker.ts"]
