# pnpm Docker recipe: https://pnpm.io/docker (node:22-slim + corepack)
FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

# System dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ca-certificates \
  gnupg \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -g ${AGENT_GID} node \
  && usermod -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}

# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash

ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace.
# Do not copy host node_modules — pnpm cannot hardlink across the mount.
ENTRYPOINT ["sleep", "infinity"]
