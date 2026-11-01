FROM node:22-slim
ARG AGENT_UID=1000

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

RUN set -eux; \
    if getent passwd "${AGENT_UID}" >/dev/null; then \
      existing_user="$(getent passwd "${AGENT_UID}" | cut -d: -f1)"; \
      existing_group="$(id -gn "${existing_user}")"; \
      if [ "${existing_group}" != "agent" ]; then groupmod -n agent "${existing_group}"; fi; \
      if [ "${existing_user}" != "agent" ]; then usermod -l agent -d /home/agent -m "${existing_user}"; fi; \
    else \
      groupadd -g "${AGENT_UID}" agent; \
      useradd -m -s /bin/bash -u "${AGENT_UID}" -g agent agent; \
    fi

RUN mkdir -p /home/agent/.local/share/opencode && \
    mkdir -p /home/agent/.local/state && \
    mkdir -p /home/agent/.opencode && \
    mkdir -p /home/agent/.npm && \
    mkdir -p /home/agent/workspace && \
    chown -R agent:agent /home/agent

COPY --chown=agent:agent agent-entrypoint.sh /home/agent/entrypoint.sh
RUN chmod +x /home/agent/entrypoint.sh

USER agent
WORKDIR /home/agent

ENTRYPOINT ["/home/agent/entrypoint.sh"]
