# Gravador de telas

Grave a tela, uma janela ou uma aba direto no navegador. Dá para incluir o áudio do sistema, o microfone e a câmera flutuante. Não precisa de instalação, servidor nem dependências: tudo roda localmente e nada é enviado para a internet.

## Recursos

- **Área de gravação:** tela toda ou só uma parte, desenhada com o mouse: retângulo, quadrado, redondo ou livre (laço). Nas formas redonda e livre, a parte de fora fica preta, branca ou verde (chroma key, para recortar no editor).
- Grava em **MP4** (Chrome/Edge 126+, Safari) ou WebM
- Áudio da tela/aba e do microfone, misturados numa única faixa
- **Pausar e continuar**, cronômetro e contagem regressiva
- **Câmera flutuante** (Document Picture-in-Picture), que fica sempre por cima e aparece na gravação da tela inteira. Substitui o antigo "mosaico" do Google Slides e funciona com qualquer app.
- **Câmera dentro do vídeo:** desenhada direto na gravação, sem janela nem moldura. Redonda, quadrada ou retangular, com **legenda** opcional embaixo. Aparece na prévia exatamente onde vai sair no vídeo: **arraste** para qualquer lugar e use a **rodinha do mouse** para o tamanho, inclusive durante a gravação. Em "Opções avançadas" há também a janela flutuante do navegador.
- **Microfone liga/desliga durante a gravação:** botão na barra de controles ou tecla **M**.
- **Câmera no meio da gravação com prévia:** ao ligar a câmera gravando, ela aparece primeiro só na prévia (contorno amarelo) para ajustar posição, tamanho, fundo e efeito. Só entra no vídeo ao clicar em **Colocar no vídeo**.
- **Escolha de câmera e microfone:** listas "Qual câmera" e "Qual microfone" (a escolha fica salva). Dá para trocar **durante a gravação**, sem cortar o vídeo nem o áudio.
- **Trocar tela durante a gravação:** o botão **Trocar tela** pausa, deixa escolher outra tela, janela ou aba e continua no mesmo arquivo. Se a área for recortada, você marca a área de novo na tela nova. Telas de proporção diferente ganham faixas na cor de fundo.
- **Tudo fica salvo no navegador:** configurações, gravações e histórico continuam lá depois de recarregar. Se a página fechar no meio de uma gravação, o vídeo é **recuperado**. O botão "Exportar histórico (JSON)" baixa configurações, lista de gravações e log de uso.
- **Fundo e efeitos da câmera:** desfoque leve ou forte, fundos prontos (estúdio, pôr do sol, oceano, luzes, verde chroma key), sua própria imagem e filtros (P&B, noir, sépia, vintage, cores vivas, quente, frio, mais claro). Dá para trocar durante a gravação. O recorte usa o [MediaPipe Selfie Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (Apache-2.0), que fica em `libs/mediapipe` e roda localmente.
- Qualidade (bitrate) e 30/60 fps configuráveis
- **Ajuda dentro do app:** um botão **?** em cada parte mostra um resumo rápido. O botão **Ajuda** no topo (ou as teclas **?** e **F1**) abre o guia completo, com passo a passo, exemplos, receitas prontas, atalhos e problemas comuns.
- Várias gravações por sessão, cada uma com prévia, botão de baixar e botão de excluir
- A gravação para sozinha quando você clica em "Parar compartilhamento" no navegador
- PWA instalável e com funcionamento offline; tema claro/escuro automático

## Rodar localmente

APIs de captura exigem `https://` ou `localhost`:

```sh
python3 -m http.server 8080
# abra http://localhost:8080
```

## Publicar

O site é publicado pelo GitHub Pages a partir da branch `main`. Para a configuração inicial completa (repositório, chave SSH, Pages), veja **[PUBLICAR.md](PUBLICAR.md)**. Para publicar uma atualização:

```sh
git add -A && git commit -m "descrição da mudança"
./publicar.sh          # pergunta patch/minor/major, cria a tag vX.Y.Z, gitleaks + envio sem --force
```

A versão publicada aparece ao lado do nome do app (`version.js`, gerado pelo script). Uma cópia local não publicada aparece como **dev**.

## Limitações do navegador

- **Áudio do sistema:** no Chrome, só Windows e ChromeOS capturam o áudio da tela inteira. No Linux e no macOS dá para capturar só o áudio de **abas**. O Firefox não captura áudio do sistema.
- **Celular:** os navegadores móveis não oferecem captura de tela.
- As gravações ficam na memória até você baixá-las. Gravações muito longas (horas) podem consumir bastante RAM.

## Licença

[MIT](LICENSE): você pode usar, copiar, alterar e redistribuir, inclusive para uso comercial, **desde que mantenha o aviso de autoria com a fonte original** (https://github.com/soaresnetoh/gravador-de-telas). O MediaPipe, em `libs/mediapipe`, segue a licença Apache-2.0.
