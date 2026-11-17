#!/usr/bin/env bash
# Publica o Gravador de telas no GitHub (GitHub Pages serve a branch main),
# criando uma versão nova (tag vMAJOR.MINOR.PATCH) que aparece no topo do app.
#
# 📖 Passo a passo completo (criar o repositório, gerar a chave SSH, cadastrar a
#    deploy key, ativar o Pages, versões e resolver problemas):
#    PUBLICAR.md  →  https://github.com/soaresnetoh/gravador-de-telas/blob/main/PUBLICAR.md
#
# Técnica: git/ssh/gitleaks em container (nada
# configurado no host), deploy key exclusiva deste repositório, gitleaks no
# histórico antes do envio e NUNCA --force.
#
# Uso:
#   ./publicar.sh                  mostra a versão atual e pergunta o tipo da nova
#   ./publicar.sh patch            correção        1.4.2 → 1.4.3
#   ./publicar.sh minor            novidade        1.4.2 → 1.5.0
#   ./publicar.sh major            mudança grande  1.4.2 → 2.0.0
#   ./publicar.sh --status         só mostra as versões (local e GitHub)
#   ./publicar.sh --sem-versao     envia os commits sem criar versão nova
#   ./publicar.sh --check          só roda o gitleaks
#
# Se existir .temp/privado.sh (arquivos privados, repositório separado), ele roda
# junto: salva e envia no fim (--status e --check também passam para ele).
# Para pular: GRAVADOR_SEM_PRIVADO=1 ./publicar.sh ...
#
# Saída: 0 ok · 1 cancelado · 2 configuração · 4 gitleaks bloqueou · 5 GitHub falhou/recusou
#        6 público ok, mas a parte privada (.temp) falhou

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${GRAVADOR_REMOTE:-git@github.com:soaresnetoh/gravador-de-telas.git}"
BRANCH="${GRAVADOR_BRANCH:-main}"
DEPLOY_KEY="${GRAVADOR_DEPLOY_KEY:-$HOME/.ssh/gravador-de-telas/deploy_key}"
KNOWN_DIR="${GRAVADOR_KNOWN_DIR:-$HOME/.config/gravador-de-telas}"
SITE_URL="${GRAVADOR_SITE:-https://soaresnetoh.github.io/gravador-de-telas/}"
REPO_URL="${GRAVADOR_REPO_URL:-https://github.com/soaresnetoh/gravador-de-telas}"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.21.2"
GIT_IMAGE="alpine/git:v2.47.2"
SEMVER_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

ok()   { printf '✅ %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '❌ %s\n   Ajuda: %s/PUBLICAR.md (seção "Problemas comuns")\n' "$*" "$REPO" >&2; }

# ---------- argumentos ----------
MODE=publish
BUMP=""
case "${1:-}" in
  patch|minor|major) BUMP="$1" ;;
  --status)          MODE=status ;;
  --sem-versao)      MODE=noversion ;;
  --check)           MODE=check ;;
  -h|--help)         sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "")                ;;
  *) fail "argumento desconhecido: $1 (use patch, minor, major, --status, --sem-versao ou --check)"; exit 2 ;;
esac

# ---------- parte privada (.temp/privado.sh), roda sempre no fim ----------
PRIVADO="$REPO/.temp/privado.sh"
run_privado() {
  local rc=$1 arg=""
  trap - EXIT
  [[ $rc == 1 || -n "${GRAVADOR_SEM_PRIVADO:-}" || ! -x "$PRIVADO" ]] && exit "$rc" # cancelado / desligado / não existe
  case $MODE in status) arg=--status ;; check) arg=--check ;; esac
  echo
  echo "🔒 Parte privada (.temp)"
  if "$PRIVADO" ${arg:+"$arg"}; then exit "$rc"; fi
  printf '❌ %s\n' "a parte privada falhou — veja a mensagem acima (.temp/PRIVADO.md)" >&2
  [[ $rc == 0 ]] && exit 6
  exit "$rc"
}
trap 'run_privado $?' EXIT

# ---------- pré-checagens ----------
command -v docker >/dev/null || { fail "docker não encontrado"; exit 2; }
git -C "$REPO" rev-parse HEAD >/dev/null 2>&1 || { fail "nenhum commit em $REPO"; exit 2; }
if [[ $MODE != status && -n "$(git -C "$REPO" status --porcelain)" ]]; then
  fail "há alterações não commitadas — commite antes de publicar (só o que está commitado sobe)"
  git -C "$REPO" status --short >&2
  exit 2
fi

run_gitleaks() {
  local out
  if ! out="$(docker run --rm -v "$REPO":/repo:ro "$GITLEAKS_IMAGE" \
      detect --source /repo --no-banner --no-color --redact 2>&1)"; then
    fail "gitleaks achou possível secret no histórico — ENVIO BLOQUEADO"
    grep -E 'RuleID|File|Line|Fingerprint' <<< "$out" | head -20 >&2
    return 1
  fi
  ok "gitleaks: nenhum secret no histórico"
}

if [[ $MODE == check ]]; then run_gitleaks || exit 4; exit 0; fi

# git no container, com a deploy key (-F /dev/null ignora o ~/.ssh/config e as chaves de outras contas)
[[ -r "$DEPLOY_KEY" ]] || { fail "deploy key não encontrada: $DEPLOY_KEY"; exit 2; }
mkdir -p "$KNOWN_DIR" && chmod 700 "$KNOWN_DIR"
remote_git() {
  docker run --rm \
    -v "$REPO":/repo:ro \
    -v "$DEPLOY_KEY":/key/deploy_key:ro \
    -v "$KNOWN_DIR":/known \
    -e GIT_SSH_COMMAND="ssh -F /dev/null -i /key/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/known/known_hosts -o StrictHostKeyChecking=accept-new" \
    "$GIT_IMAGE" -c safe.directory=/repo -C /repo "$@"
}

latest_of() { grep -E "$SEMVER_RE" | sort -V | tail -1; }
newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; } # $1 > $2 ?

# ---------- versões existentes ----------
if ! ls_out="$(remote_git ls-remote --tags --refs "$REMOTE" 2>&1)"; then
  fail "não consegui ler as tags do GitHub"
  tail -5 <<< "$ls_out" >&2
  exit 5
fi
remote_latest="$(awk '{sub("refs/tags/", "", $2); print $2}' <<< "$ls_out" | latest_of)"
local_latest="$(git -C "$REPO" tag -l 'v*' | latest_of)"
app_version="$(sed -n "s/^self.APP_VERSION = '\(.*\)';/\1/p" "$REPO/version.js" 2>/dev/null)"

echo "📦 Versões"
info "No GitHub (última tag): ${remote_latest:-nenhuma ainda}"
if [[ -n "$local_latest" && "$local_latest" != "$remote_latest" ]]; then
  info "Tag local ainda não enviada: $local_latest"
fi
info "No app (version.js): ${app_version:-?}"

base="$remote_latest"
[[ -n "$local_latest" ]] && { [[ -z "$base" ]] || newer "$local_latest" "$base"; } && base="$local_latest"
if [[ -n "$base" ]] && git -C "$REPO" rev-parse -q --verify "refs/tags/$base" >/dev/null; then
  pending="$(git -C "$REPO" log --oneline "$base..HEAD")"
else
  pending="$(git -C "$REPO" log --oneline)"
fi
if [[ -n "$pending" ]]; then
  echo "📝 Commits desde ${base:-o início}:"
  head -15 <<< "$pending" | sed 's/^/   • /'
  (( $(wc -l <<< "$pending") > 15 )) && info "… e mais $(( $(wc -l <<< "$pending") - 15 ))"
fi

[[ $MODE == status ]] && exit 0

# ---------- nova versão ----------
NEW=""
if [[ -n "$local_latest" && "$local_latest" == "$base" ]] && newer "$local_latest" "${remote_latest:-v0.0.0}" \
   && [[ "$(git -C "$REPO" rev-list -n1 "$local_latest")" == "$(git -C "$REPO" rev-parse HEAD)" ]]; then
  NEW="$local_latest"
  ok "a versão $NEW já foi criada aqui e não chegou ao GitHub — reenviando"
elif [[ $MODE == noversion ]]; then
  info "Enviando sem criar versão nova (--sem-versao)."
elif [[ -z "$pending" ]]; then
  ok "nada mudou desde $base — nenhuma versão nova necessária"
else
  IFS=. read -r MA MI PA <<< "${base#v}"
  MA=${MA:-0}; MI=${MI:-0}; PA=${PA:-0}
  v_patch="v$MA.$MI.$((PA + 1))"; v_minor="v$MA.$((MI + 1)).0"; v_major="v$((MA + 1)).0.0"
  if [[ -z "$BUMP" ]]; then
    [[ -t 0 ]] || { fail "sem terminal interativo: informe o tipo (./publicar.sh patch|minor|major)"; exit 2; }
    default=1; [[ -z "$base" ]] && default=3
    echo "🏷️  Que tipo de versão é esta?"
    echo "   1) patch → $v_patch   correção (nada novo para o usuário)"
    echo "   2) minor → $v_minor   novidade (recurso novo, nada quebra)"
    echo "   3) major → $v_major   mudança grande (muda o jeito de usar)"
    [[ -z "$base" ]] && info "Primeira versão: o recomendado é 3 (v1.0.0)."
    read -r -p "   Escolha [1-3, Enter = $default, q = cancelar]: " choice
    case "${choice:-$default}" in
      1) BUMP=patch ;; 2) BUMP=minor ;; 3) BUMP=major ;;
      *) echo "Cancelado."; exit 1 ;;
    esac
  fi
  case "$BUMP" in patch) NEW="$v_patch" ;; minor) NEW="$v_minor" ;; major) NEW="$v_major" ;; esac

  if git -C "$REPO" rev-parse -q --verify "refs/tags/$NEW" >/dev/null || grep -qx "$NEW" <<< "$(awk '{sub("refs/tags/", "", $2); print $2}' <<< "$ls_out")"; then
    fail "a tag $NEW já existe — nada foi alterado"
    exit 2
  fi
  if [[ -t 0 ]]; then
    read -r -p "   Publicar $NEW? [s/N] " yn
    [[ "$yn" =~ ^[sS]$ ]] || { echo "Cancelado."; exit 1; }
  fi

  # grava a versão no app, commita e cria a tag (anotada)
  released="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$REPO/version.js" <<EOF
// Versão do app — gerado pelo publicar.sh a cada publicação. Não edite à mão.
// Lido pela página (mostra no topo) e pelo service worker (nome do cache).
self.APP_VERSION = '${NEW#v}';
self.APP_RELEASED = '$released';
EOF
  git -C "$REPO" add version.js
  git -C "$REPO" commit -q -m "versão $NEW" || { fail "não consegui commitar o version.js"; exit 2; }
  git -C "$REPO" tag -a "$NEW" -m "Versão ${NEW#v}" || { fail "não consegui criar a tag $NEW"; exit 2; }
  ok "versão $NEW criada (commit + tag locais)"
fi

# ---------- gitleaks + envio ----------
run_gitleaks || exit 4

refs=("HEAD:refs/heads/$BRANCH")
[[ -n "$NEW" ]] && refs+=("refs/tags/$NEW:refs/tags/$NEW")
if ! push_out="$(remote_git push "$REMOTE" "${refs[@]}" 2>&1)"; then
  if grep -qE 'non-fast-forward|fetch first' <<< "$push_out"; then
    fail "envio RECUSADO: o $BRANCH remoto tem commits que não existem aqui. Nada foi forçado — resolva à mão."
  else
    fail "envio falhou"
  fi
  tail -8 <<< "$push_out" >&2
  [[ -n "$NEW" ]] && info "A tag $NEW ficou só aqui; rode ./publicar.sh de novo para reenviá-la."
  exit 5
fi

if grep -q 'Everything up-to-date' <<< "$push_out"; then
  ok "GitHub já estava atualizado"
else
  ok "publicado → $REMOTE ($BRANCH, $(git -C "$REPO" rev-parse --short HEAD))"
fi
[[ -n "$NEW" ]] && info "Versão: $NEW → $REPO_URL/releases/tag/$NEW"
info "Site: $SITE_URL (o Pages leva ~1 min para atualizar)"
