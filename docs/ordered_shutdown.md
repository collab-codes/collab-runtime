# Desligamento ordenado (v1)

A VM aceita um pedido, para os serviços na ordem fixa, publica um relatório final no heartbeat e pede `shutdown -h now`. Este documento descreve o que o runtime instalado faz. Não liga a agenda do sites, não chama StopInstances e não publica collab-messages. Uso remoto espera o produtor compatível e a coordenação operacional.

A cópia em `/usr/local/lib` é a que a VM executa. O checkout pode estar à frente ou atrás dela. `shutdown-services.mjs` instalado não tem o mesmo hash do arquivo no git: o instalador troca o import `../scripts/pm2-lifecycle.mjs` pelo caminho estável `/usr/local/lib/collab/pm2-lifecycle.mjs`.

## Pedido

Só root, pela cópia instalada:

```sh
collab vm shutdown --request-id <uuid> --deadline <ISO-8601 UTC>
```

Não há destino, script nem lista de serviços na linha de comando. O sites grava o UUID e o deadline (requestedAt + 60 min) antes do SSM e repete o mesmo par nos retries. A VM deriva `requestedAt = deadline - 60 min` e `selfDeadlineAt = requestedAt + 50 min`.

O comando pega o lock `/run/collab-shutdown-admit.lock`, grava ou relê `/var/lib/collab/shutdown/current.json` (diretório 0700, arquivo 0600) e dispara `collab-shutdown.service` sem esperar o worker. Exit 0 só depois do estado durável e da unidade confirmada (`activating` ou `active`). `--no-block` com exit 0 e unidade recusada não é aceite.

| result | significado |
| --- | --- |
| `accepted` | pedido novo durável e unidade confirmada |
| `existing` | mesmo id e mesmo deadline; o disparo é retomado se ainda fizer falta |
| `busy` | outro id com ciclo deste boot ainda presente, inclusive fase final |
| `conflict` | mesmo id com deadline diferente |
| `stale_boot` | id de um boot anterior; não desliga a VM recém-ligada |
| `rejected` | argv, prazo ou usuário inválido; nenhum efeito |
| `start_unconfirmed` | estado gravado, unidade não confirmada; o mesmo id retoma |

O recibo traz `requestId`, `result` e, quando couber, `activeRequestId`. Sem segredo.

Pedido já vencido, ou com `requestedAt` derivado mais de 60 s no futuro, é rejeitado. Outro boot não reativa o pedido antigo.

## Prazos

| marca | instante | efeito |
| --- | --- | --- |
| selfDeadlineAt | requestedAt + 50 min | corte do dreno; 60 s antes disso os stops novos não começam |
| failsafe | requestedAt + 52 min | timer transitório `collab-shutdown-failsafe-<id>`, só deste boot, pede halt se o worker cair |
| unidade | RuntimeMaxSec=54min | teto do `collab-shutdown.service` |
| AWS | deadline = requestedAt + 60 min | fora deste runtime; observação da AWS, não o heartbeat |

O relógio monotônico não ganha prazo com salto do relógio de parede. Retry não empurra o failsafe para mais tarde. O timer não fica instalado no próximo boot e não é um timer diário.

## Parada e relatório

Ordem: nginx, processos PM2 de negócio (todos os vivos, inclusive os de fora do dump, exceto `msg` e `msg-worker`), `msg-worker`, `msg`, reconfirmação, Redis e clusters `postgresql@*`. O nginx para com `QUIT` e dá 30 s para as requisições em andamento terminarem (drop-in `nginx.service.d/collab-graceful-stop.conf`, `--retry QUIT/30`, `TimeoutStopSec=35`; a unidade do Ubuntu dava 5 s); o que passa disso, inclusive WebSocket aberto, é cortado. Se um app não confirma, Redis e PostgreSQL ficam só observados. `services_stopped` exige confirmação de todos. Falha de leitura entra em `notStopped`, não vira lista vazia.

Fases internas, no estado local: `requested`, `stopping`, `services_stopped`, `deadline_exceeded`, `failed`. Não vão no tipo do heartbeat.

Até o relatório congelar, o heartbeat segue o status de saúde e não manda `payload.shutdown`. O relatório final é imutável: `requestId`, `stopped`, `notStopped`, `startedAt`, `finishedAt`. O body vai com `status: shutdown_ready`. `shutdown_ready` significa pronto para tentar o halt; `notStopped` pode continuar preenchido. Retries repetem o mesmo `finishedAt`.

O worker grava `poweroffRequestedAt` e então chama `/usr/sbin/shutdown -h now`. Falha do heartbeat não segura o halt. No máximo 3 tentativas de 10 s. Chamar halt não prova instância `stopped`; isso é observação da AWS.

## Instalação

Pontual, sem parar negócio e sem editar `/etc/collab-sites-agent.env`:

```sh
sudo scripts/install-shutdown.sh --maintenance-only
sudo scripts/install-shutdown.sh --maintenance-only --restart-agent
```

O primeiro atualiza o conjunto, faz `daemon-reload` e `systemd-analyze verify`. Não dá `start` em `collab-shutdown`. O reinício do agente é o segundo comando, explícito, e só depois das cópias. O bootstrap (`install.sh`) chama o mesmo `--maintenance-only` depois de gravar o env e só então faz `enable`/`restart` de `collab-sites-agent`. Não inicia o worker.

Conjunto que anda junto:

- `/usr/local/lib/collab-sites-agent/collab-sites-agent.mjs`
- `/usr/local/lib/collab-sites-agent/shutdown-state.mjs`
- `/usr/local/lib/collab-sites-agent/shutdown-worker.mjs`
- `/usr/local/lib/collab-sites-agent/shutdown-services.mjs`
- `/etc/systemd/system/nginx.service.d/collab-graceful-stop.conf`
- `/usr/local/lib/collab/pm2-lifecycle.mjs`
- `/etc/systemd/system/collab-shutdown.service`

A unidade não tem `[Install]` nem `WantedBy`. Não sobe no boot. `Restart=on-failure` vale para a execução já disparada.

Conferir o que está instalado, não o checkout:

```sh
sha256sum /usr/local/lib/collab-sites-agent/*.mjs /usr/local/lib/collab/pm2-lifecycle.mjs
```

## Rollback

Restaurar as seis peças da revisão anterior compatível, `daemon-reload`, e só então reiniciar `collab-sites-agent` se essa revisão de agente for a que deve voltar a responder. Apagar ou trocar só `collab-sites-agent.mjs` deixa import pendente (`shutdown-state.mjs` / `shutdown-worker.mjs`). Apagar só um módulo do shutdown quebra o worker da mesma forma. O rollback não dá `start` em `collab-shutdown` e não mexe no env.

## Fora deste runtime

Agenda 23h/7h, força pela AWS, persistência do UUID no sites e publicação do collab-messages ficam com o produtor. Status SSM de erro não é VM parada. Sem o acordo e a prova pareada, o comando não entra na agenda.
