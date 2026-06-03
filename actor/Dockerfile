# Apify's official Node + Playwright image (Chrome pre-installed)
FROM apify/actor-node-playwright-chrome:20

# Copy package files first (better layer caching)
COPY --chown=myuser package*.json ./

# Install production deps
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed packages:" \
    && npm list --omit=dev --all || true

# Copy the rest of the source
COPY --chown=myuser . ./

# Default command
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
