# Plan: WebDocument Content Extraction

## Objectif

Permettre la recherche dans les fichiers HTML à la fois :
- **Comme code** (recherche dans le HTML brut, structure préservée)
- **Comme contenu** (recherche dans le texte extrait via markdown)

---

## Approche retenue : Chunking HTML Hiérarchique + Fallback EmbeddingChunk

### Principe

```
HTML trop gros?
     │
     ▼
┌─────────────────────────────┐
│  1. Tags sémantiques?       │  header, nav, main, article, section, aside, footer
│     → Créer HtmlSection     │
└─────────────────────────────┘
     │ encore trop gros?
     ▼
┌─────────────────────────────┐
│  2. Récursion dans enfants  │  div[id], div[class], autres éléments
│     → HtmlSection level+1   │
└─────────────────────────────┘
     │ maxDepth atteint et encore trop gros?
     ▼
┌─────────────────────────────┐
│  3. Fallback EmbeddingChunk │  Chunking par chars (logique existante)
│     → EmbeddingChunk nodes  │
└─────────────────────────────┘
```

### Exemple concret

```html
<html>
  <body>                           <!-- trop gros, descend -->
    <header>Small header</header>  <!-- HtmlSection level=1, OK -->
    <main>                         <!-- trop gros, descend -->
      <article id="post-1">        <!-- HtmlSection level=2 -->
        <h1>Title</h1>
        <div class="content">      <!-- trop gros, level=3 -->
          <p>Very long text...</p> <!-- maxDepth=4 atteint, encore trop gros -->
          <p>...</p>               <!-- → EmbeddingChunk fallback -->
        </div>
      </article>
    </main>
    <footer>Small footer</footer>  <!-- HtmlSection level=1, OK -->
  </body>
</html>
```

**Résultat** :
```
WebDocument (index.html)
├── HtmlSection (level=1, tag=header) ──────── embedding direct
├── HtmlSection (level=1, tag=main)
│   └── HtmlSection (level=2, tag=article#post-1)
│       └── HtmlSection (level=3, tag=div.content)
│           ├── EmbeddingChunk[0] ───────────── fallback chunking
│           └── EmbeddingChunk[1]
└── HtmlSection (level=1, tag=footer) ───────── embedding direct
```

---

## Mapping des champs HtmlSection

### Règles de mapping

| Champ | Source | Exemple |
|-------|--------|---------|
| `_name` | `id` si existe, sinon début de la balise (50 chars max) | `post-1` ou `<article class="blog` |
| `_description` | Ligne entière de la balise ouvrante | `<article id="post-1" class="blog-post" data-author="john">` |
| `_content` | Contenu intérieur **SI pas découpé**, sinon `null` | `<h1>Title</h1><p>Text</p>` ou `null` |
| `usesChunks` | `true` si subdivisé (enfants HtmlSection ou EmbeddingChunk) | `true` / `false` |

### Logique d'extraction

```typescript
function extractHtmlSectionFields(node: Element, hasChildren: boolean): {
  _name: string;
  _description: string;
  _content: string | null;
  usesChunks: boolean;
} {
  // Ligne de la balise ouvrante
  const openingTagLine = node.outerHTML.split('\n')[0];

  return {
    // _name: id si existe, sinon début de la balise
    _name: node.id || openingTagLine.slice(0, 50),

    // _description: ligne complète de la balise ouvrante
    _description: openingTagLine,

    // _content: contenu seulement si pas subdivisé (évite duplication)
    _content: hasChildren ? null : node.innerHTML,

    // usesChunks: indique si le contenu est dans les enfants
    usesChunks: hasChildren,
  };
}
```

### Exemples concrets

**Section feuille (pas de sous-division)** :
```typescript
{
  _name: "sidebar",
  _description: '<aside id="sidebar" class="sticky">',
  _content: '<nav><a href="/">Home</a><a href="/about">About</a></nav>',
  usesChunks: false,
}
// → Embedding généré sur _name + _content
```

**Section avec sous-divisions** :
```typescript
{
  _name: "main-content",
  _description: '<main id="main-content" role="main">',
  _content: null,  // Contenu dans les enfants
  usesChunks: true,
}
// → Pas d'embedding sur _content, chercher dans les enfants
```

**Section sans id (fallback sur balise)** :
```typescript
{
  _name: '<div class="card-container flex gap-4">',
  _description: '<div class="card-container flex gap-4 mt-8 p-4">',
  _content: null,
  usesChunks: true,
}
```

### Avantages de cette approche

1. **Pas de duplication** : Le contenu est soit dans le parent, soit dans les enfants, jamais les deux
2. **Recherche par id/class** : `_name` indexé permet de trouver `id="sidebar"` ou `class="nav"`
3. **Contexte préservé** : `_description` garde tous les attributs pour le debug/affichage
4. **Performance** : `usesChunks` évite de chercher dans les parents quand le contenu est chunké

---

## Architecture proposée

```
                    ┌─────────────────────────────────────────┐
                    │              HTML File                   │
                    │         (index.html, page.html)          │
                    └─────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
        ┌───────────────────┐ ┌─────────────┐ ┌─────────────────────┐
        │   WebDocument     │ │   Scope     │ │ WebDocumentContent  │
        │   (raw HTML)      │ │  (scripts)  │ │   (markdown)        │
        └───────────────────┘ └─────────────┘ └─────────────────────┘
                    │                               │
                    ▼                               ▼
        ┌───────────────────┐           ┌─────────────────────┐
        │  EmbeddingChunk   │           │   MarkdownSection   │
        │  (HTML chunks)    │           │  (text chunks)      │
        └───────────────────┘           └─────────────────────┘
```

## 1. WebDocument (Code Search)

**Objectif** : Pouvoir chercher dans le code HTML brut

**Implémentation** :
- Stocker `_rawContent` = HTML source complet
- Chunker en morceaux de ~1500 chars (comme EmbeddingChunk)
- Embeddings sur le code HTML

```typescript
// WebDocument node
{
  labels: ['WebDocument'],
  properties: {
    uuid: 'webdoc:xxx',
    file: 'index.html',
    _name: 'index.html',
    _rawContent: '<html>...</html>',  // HTML brut complet
    _contentHash: 'abc123',
    usesChunks: true,  // Si > 1500 chars
    // ... metadata existantes (hasScript, hasStyle, etc.)
  }
}

// EmbeddingChunk nodes pour le HTML
{
  labels: ['EmbeddingChunk'],
  properties: {
    uuid: 'chunk:webdoc:xxx:0',
    parentUuid: 'webdoc:xxx',
    chunkIndex: 0,
    content: '<div class="header">...',  // Chunk du HTML
    embedding_content: [...],
  }
}
```

## 2. Scope (Script Parsing - déjà existant)

**Objectif** : Parser les `<script>` tags comme du code JS/TS

**Status** : ✅ Déjà implémenté
- Les scripts sont extraits et parsés avec le code parser
- Créent des Scope nodes avec fonctions, classes, etc.
- Relation `SCRIPT_OF` vers WebDocument

## 3. WebDocumentContent (Content Search)

**Objectif** : Pouvoir chercher dans le contenu textuel (comme un PDF)

**Implémentation** :
- Convertir HTML → Markdown via Turndown
- Créer un noeud `WebDocumentContent` (ou réutiliser `MarkdownDocument`)
- Chunker le markdown en `MarkdownSection`

```typescript
// Option A: Nouveau label WebDocumentContent
{
  labels: ['WebDocumentContent'],
  properties: {
    uuid: 'webcontent:xxx',
    file: 'index.html',
    _name: 'Page Title',
    _content: '# Page Title\n\nThis is the content...',  // Markdown
    _description: 'Converted from HTML',
    sourceType: 'html',
  }
}

// Option B: Réutiliser MarkdownDocument avec sourceType
{
  labels: ['MarkdownDocument'],
  properties: {
    uuid: 'md:xxx',
    file: 'index.html',
    sourceType: 'html',  // Indique que c'est converti depuis HTML
    _content: '# Page Title\n\n...',
  }
}
```

**Relation** :
```
(WebDocument)-[:HAS_CONTENT]->(WebDocumentContent)
(WebDocumentContent)-[:IN_SECTION]->(MarkdownSection)
```

## Implémentation

### Phase 1: Stocker le HTML brut dans WebDocument

**Fichier** : `src/runtime/adapters/code-source-adapter.ts`

```typescript
// Dans buildGraph(), section WebDocument:
for (const [filePath, htmlResult] of htmlFiles) {
  const content = await fs.readFile(filePath, 'utf-8');

  nodes.push({
    labels: ['WebDocument'],
    id: docId,
    properties: {
      // ... propriétés existantes
      _rawContent: content,  // AJOUTER: HTML brut
      _contentHash: hashContent(content),
    },
  });
}
```

### Phase 2: Convertir en Markdown

**Dépendance** : `turndown` (HTML to Markdown)

```bash
npm install turndown @types/turndown
```

**Fichier** : `src/ingestion/parsers/html-content-extractor.ts` (nouveau)

```typescript
import TurndownService from 'turndown';

export class HtmlContentExtractor {
  private turndown: TurndownService;

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });

    // Ignorer scripts et styles
    this.turndown.remove(['script', 'style', 'noscript']);
  }

  /**
   * Convertit HTML en Markdown propre
   */
  extractContent(html: string): {
    markdown: string;
    title: string | null;
    headings: string[];
  } {
    // Extraire le titre
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;

    // Convertir en markdown
    const markdown = this.turndown.turndown(html);

    // Extraire les headings pour la structure
    const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)]
      .map(m => m[1]);

    return { markdown, title, headings };
  }
}
```

### Phase 3: Créer WebDocumentContent nodes

**Fichier** : `src/runtime/adapters/code-source-adapter.ts`

```typescript
// Après création de WebDocument, créer aussi WebDocumentContent
const extractor = new HtmlContentExtractor();
const { markdown, title, headings } = extractor.extractContent(content);

if (markdown.trim()) {
  const contentId = UniqueIDHelper.GenerateContentUUID(filePath, 'html');

  nodes.push({
    labels: ['WebDocumentContent'],
    id: contentId,
    properties: {
      uuid: contentId,
      file: relPath,
      _name: title || relPath,
      _content: markdown,
      _description: `Extracted from ${doc.type} document`,
      sourceType: doc.type,
      headingCount: headings.length,
      _state: 'linked',
    },
  });

  // Relation vers WebDocument source
  relationships.push({
    type: 'HAS_CONTENT',
    from: docId,
    to: contentId,
  });
}
```

### Phase 4: Chunking du contenu

Le chunking sera géré automatiquement par le système existant :
- Si `_content` > 3000 chars → créer des `MarkdownSection` ou `EmbeddingChunk`
- Embeddings générés sur chaque chunk

### Phase 5: Embedding configs

**Fichier** : `src/brain/embedding-service.ts`

```typescript
// Ajouter config pour WebDocumentContent
{
  label: 'WebDocumentContent',
  query: `MATCH (w:WebDocumentContent {projectId: $projectId})
          RETURN w.uuid AS uuid, w._name AS _name, w._content AS _content,
                 w._description AS _description,
                 w.embedding_name_hash, w.embedding_content_hash,
                 w.embedding_description_hash,
                 w.embedding_provider, w.embedding_model,
                 w.${P.state} AS _state`,
  embeddings: buildEmbeddingConfigs('WebDocumentContent', true),
},
```

## Résultat final

Pour un fichier `index.html` :

```
index.html
├── WebDocument (HTML brut, chunké)
│   ├── EmbeddingChunk[0] → embedding pour chercher "class=\"header\""
│   ├── EmbeddingChunk[1] → embedding pour chercher "<div id=\"app\">"
│   └── ...
├── Scope (scripts parsés)
│   ├── function initApp() → embedding code
│   └── class App → embedding code
└── WebDocumentContent (markdown converti)
    └── MarkdownSection / chunks → embeddings pour chercher "Welcome to our site"
```

## Cas d'usage

| Recherche | Noeud utilisé |
|-----------|---------------|
| `class="nav-item"` | WebDocument / EmbeddingChunk |
| `function handleClick` | Scope |
| `Welcome to our website` | WebDocumentContent |
| `button onclick` | WebDocument (code) |
| `contact information` | WebDocumentContent (contenu) |

## Ordre d'implémentation

1. [ ] Stocker `_rawContent` dans WebDocument
2. [ ] Ajouter chunking pour WebDocument (EmbeddingChunk)
3. [ ] Installer turndown
4. [ ] Créer HtmlContentExtractor
5. [ ] Créer WebDocumentContent nodes
6. [ ] Ajouter embedding config pour WebDocumentContent
7. [ ] Tester recherche code vs contenu
