# Apify's official Node + Playwright image (Chrome pre-installed)
FROM apify/actor-node-playwright-chrome:20

# Copy package files first (better layer caching)
COPY --chown=myuser package*.json ./

# Install production deps.
# NOTE: package.json pins "playwright": "*" on purpose. The base image ships a
# Chromium build matched to a specific Playwright version; "*" lets npm keep that
# pre-installed version instead of pulling a newer one whose browser isn't present
# (which would crash at launch). Do NOT switch this to `npm ci` — that would
# reinstall the locked Playwright version and re-introduce the browser mismatch.
# For fully reproducible builds, pin the base image tag instead (e.g. :20-<pwVersion>).
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed packages:" \
    && npm list --omit=dev --all || true

# Copy the rest of the source
COPY --chown=myuser . ./

# Default command
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
