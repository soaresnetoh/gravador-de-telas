# Como publicar o Gravador de telas no GitHub Pages

Passo a passo completo, do zero: criar o repositório, gerar a chave SSH, configurar o GitHub, enviar o código e deixar o site no ar. Depois de configurado, publicar uma versão nova é um comando só (veja [Publicar uma atualização](#8-publicar-uma-atualização)).

**Resultado:** o app fica em `https://<usuario>.github.io/gravador-de-telas/`, com HTTPS (o navegador exige HTTPS para captura de tela, câmera e microfone).

Neste projeto: usuário `soaresnetoh` e repositório `gravador-de-telas`. Para outra conta, troque esses nomes nos comandos e nas variáveis do `publicar.sh` (ver [Variáveis](#variáveis-do-publicarsh)).

---

## Pré-requisitos

- **git** e **Docker** instalados. O envio roda em containers (`alpine/git` e `gitleaks`), então não é preciso configurar git nem ssh na máquina para o push.
  ```sh
  git --version && docker info --format '{{.ServerVersion}}'
  ```
- **Conta no GitHub.** Na conta gratuita, o GitHub Pages só publica **repositório público**; para repositório privado é preciso GitHub Pro.

---

## 1. Criar o repositório no GitHub

1. Acesse https://github.com/new
2. **Owner:** sua conta (`soaresnetoh`). **Repository name:** `gravador-de-telas`.
3. **Visibility:** **Public**.
4. **Não marque** "Add a README", ".gitignore" nem "license". O repositório precisa nascer **vazio**. Se o GitHub criar um commit inicial, o primeiro push é recusado (o script nunca usa `--force`).
5. Clique em **Create repository**.

---

## 2. Criar a chave SSH (deploy key)

A **deploy key** é uma chave SSH que dá acesso a **um único repositório**. Se ela vazar, as suas outras contas e repositórios não ficam expostos.

```sh
# pasta só sua (700 = só o dono lê/escreve)
mkdir -p ~/.ssh/gravador-de-telas && chmod 700 ~/.ssh/gravador-de-telas

# gera o par de chaves ed25519, sem senha (-N ""), para uso automático pelo script
ssh-keygen -t ed25519 -N "" -C "deploy gravador-de-telas" -f ~/.ssh/gravador-de-telas/deploy_key

# garante permissões corretas
chmod 600 ~/.ssh/gravador-de-telas/deploy_key
chmod 644 ~/.ssh/gravador-de-telas/deploy_key.pub
```

Isso cria dois arquivos:

| Arquivo | O que é | Pode compartilhar? |
|---|---|---|
| `deploy_key` | chave **privada**: fica só na sua máquina | **Nunca**: não cole, não envie, não commite |
| `deploy_key.pub` | chave **pública**: vai para o GitHub | Sim, é feita para isso |

Para copiar a chave pública:

```sh
cat ~/.ssh/gravador-de-telas/deploy_key.pub
```

Copie a linha inteira, que começa com `ssh-ed25519`.

---

## 3. Cadastrar a deploy key no GitHub

1. Abra https://github.com/soaresnetoh/gravador-de-telas/settings/keys/new
   (ou: repositório → **Settings** → menu lateral **Security** → **Deploy keys** → **Add deploy key**).
   Se a aba **Settings** não aparecer no topo, ela está no menu **More**.
2. **Title:** algo que identifique a máquina, por exemplo `publicar.sh (notebook)`.
3. **Key:** cole a linha `ssh-ed25519 ...`.
4. Marque **Allow write access**. Sem isso o GitHub só permite leitura e o push falha.
5. Clique em **Add key**. O GitHub pode pedir sua senha ou 2FA.

---

## 4. Preparar o repositório local

Só na primeira vez. Se a pasta já tem `.git`, pule para o passo 5.

```sh
cd ~/gravador-de-telas
git init -b main

# identidade só deste repositório (o histórico é público: use o e-mail que você quer expor)
git config user.name  "Hernani Soares"
git config user.email "soaresnetoh@gmail.com"

git add -A
git commit -m "Gravador de telas: versão inicial"
```

> O `git config` sem `--global` vale **só para este repositório**. Assim, o e-mail de trabalho configurado globalmente não aparece no histórico público da conta pessoal.

---

## 5. Primeiro envio

```sh
cd ~/gravador-de-telas
./publicar.sh
```

O script faz, nesta ordem:

1. **Confere** se o Docker existe e se não há alteração sem commit. Só sobe o que está commitado.
2. **gitleaks:** varre o histórico inteiro procurando senhas e tokens. Se achar algo, **bloqueia o envio** e mostra só o local, com o valor mascarado.
3. **Push** em container `alpine/git`, com a deploy key montada só para leitura e `ssh -F /dev/null` para ignorar o seu `~/.ssh/config` e não usar a chave de outra conta. **Nunca usa `--force`.**

Na primeira conexão, o ssh registra a impressão digital do GitHub em `~/.config/gravador-de-telas/known_hosts`.

Para rodar só a verificação de segredos, sem enviar:

```sh
./publicar.sh --check
```

---

## 6. Ativar o GitHub Pages

Só na primeira vez, **depois** do primeiro push:

1. Abra https://github.com/soaresnetoh/gravador-de-telas/settings/pages
   (ou: **Settings** → menu lateral **Code and automation** → **Pages**).
2. Em **Build and deployment**:
   - **Source:** `Deploy from a branch`
   - **Branch:** `main` e, ao lado, a pasta `/ (root)`
   - Clique em **Save**.
3. Aguarde 1 ou 2 minutos. O progresso aparece na aba **Actions**, como *pages build and deployment*.
4. Recarregue a página de Pages. No topo deve aparecer:
   **"Your site is live at https://soaresnetoh.github.io/gravador-de-telas/"**
5. Ainda nessa página, deixe **Enforce HTTPS** marcado. Ele vem ligado por padrão.

> O arquivo `.nojekyll` na raiz diz ao GitHub para servir os arquivos como estão, sem passar pelo Jekyll. O app não tem etapa de build.

---

## 7. Conferir o site

- Abra `https://soaresnetoh.github.io/gravador-de-telas/` no Chrome ou Edge.
- O botão **Instalar app** deve aparecer no topo. Instalado, o app ganha ícone próprio e funciona offline.
- Ative a câmera e escolha um plano de fundo, para confirmar que o recorte (MediaPipe, em `libs/`) carrega.

---

## 8. Publicar uma atualização (com versão)

```sh
cd ~/gravador-de-telas
git add -A
git commit -m "o que mudou"
./publicar.sh
```

O script mostra a **última versão publicada** (tag no GitHub), lista os commits desde ela e pergunta o tipo da nova versão, seguindo o [versionamento semântico](https://semver.org/lang/pt-BR/) `vMAJOR.MINOR.PATCH`:

| Escolha | Quando usar | Exemplo |
|---|---|---|
| **1) patch** | correção, sem nada novo para quem usa | v1.4.2 → v1.4.3 |
| **2) minor** | recurso novo, nada deixa de funcionar | v1.4.2 → v1.5.0 |
| **3) major** | mudança grande no jeito de usar | v1.4.2 → v2.0.0 |

Na primeira publicação (sem nenhuma tag), o recomendado é **major → v1.0.0**.

Depois da escolha, o script:
1. grava a versão em `version.js`. O app mostra **vX.Y.Z** ao lado do nome, e o cache do app troca sozinho, então quem já instalou recebe a atualização;
2. faz o commit `versão vX.Y.Z` e cria a **tag anotada** `vX.Y.Z`;
3. roda o gitleaks e envia a branch e a tag juntas.

Atalhos sem perguntas:

```sh
./publicar.sh patch        # ou minor / major
./publicar.sh --status     # só mostra as versões (GitHub e local) e os commits pendentes
./publicar.sh --sem-versao # envia commits sem criar versão (ex.: só documentação)
```

- **Se o envio falhar** depois da tag criada, ela fica só na sua máquina. Rode `./publicar.sh` de novo: ele percebe e **reenvia a mesma versão**, sem criar outra.
- **Ver todas as versões:** https://github.com/soaresnetoh/gravador-de-telas/tags. O selo de versão no app também leva para lá.
- **Quer notas de versão?** Em *Releases → Draft a new release*, escolha a tag e clique em *Generate release notes*. É opcional; o site não depende disso.

O Pages republica sozinho a cada envio, em cerca de 1 minuto.

---

## Problemas comuns

| Mensagem / sintoma | Causa | Solução |
|---|---|---|
| `Permission denied (publickey)` | Deploy key não cadastrada, cadastrada em outro repositório ou sem **Allow write access** | Refaça o [passo 3](#3-cadastrar-a-deploy-key-no-github) e confira a caixa de escrita |
| `deploy key não encontrada` | O arquivo não está em `~/.ssh/gravador-de-telas/deploy_key` | Refaça o [passo 2](#2-criar-a-chave-ssh-deploy-key) ou aponte `GRAVADOR_DEPLOY_KEY` |
| `push RECUSADO` / `non-fast-forward` | O GitHub tem commits que não existem aqui (ex.: README criado pelo site) | Traga as mudanças de lá e combine com as suas. O script nunca força, de propósito |
| `gitleaks achou possível secret` | Algo parecido com senha ou token entrou num commit | Remova do arquivo **e do histórico** antes de publicar. Se for falso positivo, avalie com calma |
| `há alterações não commitadas` | Arquivos mudados sem commit | `git add -A && git commit -m "..."` |
| Site dá **404** | Pages não ativado, ou o primeiro deploy ainda está rodando | Faça o [passo 6](#6-ativar-o-github-pages) e aguarde a aba **Actions** terminar |
| Site mostra versão antiga | Cache do navegador ou do app | Confira o selo **vX.Y.Z** no topo. Se estiver antigo, aguarde 1 minuto e recarregue com **Ctrl+Shift+R** |
| `a tag vX.Y.Z já existe` | Essa versão já foi publicada | Escolha outro tipo (patch/minor/major). O script nunca sobrescreve uma tag |
| `sem terminal interativo` | Rodou sem terminal (cron, CI, outro script) | Informe o tipo: `./publicar.sh patch` |

---

## Segurança e manutenção

- **Trocar a chave** (ex.: notebook novo ou suspeita de vazamento): gere outra (passo 2), cadastre (passo 3) e **apague a antiga** em *Settings → Deploy keys*.
- **Revogar o acesso:** basta apagar a deploy key no GitHub. O repositório e o site continuam no ar.
- A chave privada **nunca** deve ir para o repositório. O `publicar.sh` só aponta para o arquivo e o monta no container como somente leitura.

### Variáveis do `publicar.sh`

| Variável | Padrão |
|---|---|
| `GRAVADOR_REMOTE` | `git@github.com:soaresnetoh/gravador-de-telas.git` |
| `GRAVADOR_BRANCH` | `main` |
| `GRAVADOR_DEPLOY_KEY` | `~/.ssh/gravador-de-telas/deploy_key` |
| `GRAVADOR_KNOWN_DIR` | `~/.config/gravador-de-telas` |

Exemplo para outra conta: `GRAVADOR_REMOTE=git@github.com:outra-conta/gravador-de-telas.git ./publicar.sh`

## Arquivos privados junto da publicação (opcional)

Se existir um script executável em `.temp/privado.sh`, o `publicar.sh` roda esse script **no fim**, mesmo quando a parte pública falha:
- o `--status` e o `--check` são repassados para ele;
- a saída **6** significa que o público foi publicado, mas a parte privada falhou;
- para pular a parte privada, rode `GRAVADOR_SEM_PRIVADO=1 ./publicar.sh ...`.

A pasta `.temp/` está no `.gitignore` e nunca vai para este repositório.
