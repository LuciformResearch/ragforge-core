# Intelligent Crawlers with GLiNER

> **Status**: Idea / RFC
> **Date**: 2025-01-17
> **Author**: Lucie

## Vision

Créer une suite de crawlers intelligents qui utilisent GLiNER pour:
1. Découvrir des liens/références de manière sémantique (pas juste regex)
2. Comprendre la structure des données (API, DB) automatiquement
3. Mapper les champs vers les propriétés normalisées de RagForge

---

## 1. Web Crawler (GLiNER-based)

### Concept

Un crawler web qui utilise GLiNER pour détecter les URLs plutôt que de parser le HTML.

**Avantage**: Capture les références textuelles comme:
- "voir la doc sur docs.example.com"
- "le code est disponible sur GitHub"
- "contactez support@company.com"

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GLiNER Web Crawler                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Input:                                                         │
│    - seed_url: str                                              │
│    - max_depth: int (default: 2)                                │
│    - max_pages: int (default: 50)                               │
│    - allowed_domains: list[str] (vide = seed domain only)       │
│    - blocked_patterns: list[str] (regex: /login, /admin...)     │
│    - delay_ms: int (default: 500, politesse)                    │
│                                                                 │
│  Pipeline:                                                      │
│    1. Fetch page → HTML to text                                 │
│    2. GLiNER extract: [url, endpoint, email, file_path]         │
│    3. Normalize URLs (resolve relative, dedupe)                 │
│    4. Filter (domain whitelist, visited set, patterns)          │
│    5. Queue URLs if depth < max_depth                           │
│    6. Store in Neo4j: WebPage + LINKS_TO + entities             │
│                                                                 │
│  Output:                                                        │
│    - WebPage nodes avec contenu                                 │
│    - Relations LINKS_TO entre pages                             │
│    - Entities extraites du contenu                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Entity Types pour le crawling

```yaml
# Ajout à entity-extraction.yaml
crawling:
  description: "Web crawling and link discovery"
  entity_types:
    - url              # https://example.com/page
    - endpoint         # /api/v1/users
    - email            # contact@example.com
    - file_path        # docs/README.md
    - domain           # example.com
    - ip_address       # 192.168.1.1
    - port             # :8080, :443
  relation_types:
    links_to: "page links to url"
    mentions: "page mentions domain or email"
    references: "page references file_path"
```

### Pseudo-code

```python
class GLiNERWebCrawler:
    def __init__(self, gliner_client, config: CrawlConfig):
        self.gliner = gliner_client
        self.config = config
        self.visited: set[str] = set()
        self.queue: deque[tuple[str, int]] = deque()  # (url, depth)

    async def crawl(self, seed_url: str) -> CrawlResult:
        self.queue.append((seed_url, 0))
        pages_crawled = 0

        while self.queue and pages_crawled < self.config.max_pages:
            url, depth = self.queue.popleft()

            if url in self.visited:
                continue

            self.visited.add(url)

            # Fetch
            content = await self.fetch_page(url)
            if not content:
                continue

            # Extract links with GLiNER
            extraction = await self.gliner.extract(
                text=content.text,
                entity_types=["url", "endpoint", "email", "file_path"],
            )

            # Process discovered URLs
            if depth < self.config.max_depth:
                for entity in extraction.entities:
                    if entity.type in ["url", "endpoint"]:
                        resolved_url = self.resolve_url(url, entity.name)
                        if self.should_crawl(resolved_url):
                            self.queue.append((resolved_url, depth + 1))

            # Store in Neo4j
            await self.store_page(url, content, extraction)
            pages_crawled += 1

            # Politeness delay
            await asyncio.sleep(self.config.delay_ms / 1000)

        return CrawlResult(pages_crawled=pages_crawled, ...)
```

---

## 2. API Crawler

### Concept

Un crawler qui découvre et explore des APIs REST/GraphQL automatiquement.

### Sources de découverte

1. **OpenAPI/Swagger specs** - Parser le schema
2. **GLiNER sur la documentation** - Extraire les endpoints mentionnés
3. **Exploration dynamique** - Suivre les liens HAL/HATEOAS
4. **Analyse des réponses** - Détecter des URLs dans les payloads

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      API Crawler                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Input:                                                         │
│    - base_url: str (ex: https://api.example.com)                │
│    - auth: dict (bearer, api_key, oauth...)                     │
│    - spec_url: str | None (OpenAPI spec)                        │
│    - max_endpoints: int                                         │
│    - methods: list[str] (default: ["GET"])                      │
│                                                                 │
│  Discovery:                                                     │
│    1. Si spec_url → parser OpenAPI/Swagger                      │
│    2. Sinon → essayer /openapi.json, /swagger.json, /docs       │
│    3. GLiNER sur docs/README pour trouver endpoints             │
│    4. Explorer les réponses pour liens HATEOAS                  │
│                                                                 │
│  Pour chaque endpoint:                                          │
│    1. Call GET (ou autre method)                                │
│    2. Analyser la réponse (JSON schema inference)               │
│    3. GLiNER sur les valeurs string pour entités                │
│    4. Détecter les URLs dans la réponse → queue                 │
│                                                                 │
│  Output:                                                        │
│    - APIEndpoint nodes                                          │
│    - APIResponse samples                                        │
│    - Schema inféré                                              │
│    - Relations entre endpoints                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Entity Types pour APIs

```yaml
api:
  description: "API discovery and documentation"
  entity_types:
    - endpoint          # /users/{id}
    - http_method       # GET, POST, PUT, DELETE
    - parameter         # user_id, page, limit
    - header            # Authorization, Content-Type
    - status_code       # 200, 404, 500
    - media_type        # application/json
    - schema_type       # User, Product, Order
  relation_types:
    accepts: "endpoint accepts parameter"
    returns: "endpoint returns schema_type"
    requires: "endpoint requires header"
```

---

## 3. Database Crawler

### Concept

Un crawler qui se connecte à une base de données et:
1. Découvre le schéma (tables, colonnes)
2. **Mappe automatiquement les champs vers les propriétés RagForge**
3. Extrait les données et crée des nodes

### Le problème du Field Mapping

Quand on ingère une table `products`, comment savoir que:
- `product_name` → `_name`
- `description` → `_description`
- `long_description` → `_content`
- `id` ou `uuid` → `uuid`
- `unit_price` → `price` (entity)
- `created_at` → metadata

### Solution: GLiNER Field Classification

Utiliser GLiNER pour classifier chaque colonne:

```python
# Pour chaque colonne, on génère un "contexte"
column_context = f"""
Table: {table_name}
Column: {column_name}
Type: {column_type}
Sample values: {sample_values[:5]}
"""

# GLiNER extrait le "rôle" de la colonne
extraction = gliner.extract(
    text=column_context,
    entity_types=[
        "identifier",      # uuid, id, primary key
        "name_field",      # title, name, label
        "description",     # desc, summary, about
        "content",         # body, text, content, html
        "price",           # price, cost, amount
        "date",            # created_at, updated_at
        "url",             # link, href, image_url
        "email",           # email, contact
        "foreign_key",     # user_id, category_id
    ]
)
```

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Database Crawler                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Input:                                                         │
│    - connection_string: str                                     │
│    - tables: list[str] | None (None = all)                      │
│    - sample_size: int (pour inférence, default: 100)            │
│    - auto_map: bool (utiliser GLiNER pour mapping)              │
│    - manual_mapping: dict[str, dict] (override)                 │
│                                                                 │
│  Phase 1: Schema Discovery                                      │
│    1. INFORMATION_SCHEMA ou équivalent                          │
│    2. Pour chaque table: colonnes, types, contraintes           │
│    3. Détecter les relations (FK, naming conventions)           │
│                                                                 │
│  Phase 2: Field Classification (GLiNER)                         │
│    Pour chaque colonne:                                         │
│    1. Générer contexte (name, type, samples)                    │
│    2. GLiNER classification → rôle                              │
│    3. Mapper vers propriété RagForge                            │
│                                                                 │
│  Phase 3: Data Extraction                                       │
│    1. SELECT avec pagination                                    │
│    2. Transformer selon mapping                                 │
│    3. Créer nodes dans Neo4j                                    │
│    4. Créer relations (FK → BELONGS_TO, etc.)                   │
│                                                                 │
│  Output:                                                        │
│    - Nodes avec propriétés normalisées                          │
│    - Relations entre tables                                     │
│    - Schema mapping sauvegardé                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mapping Rules (heuristiques + GLiNER)

```python
FIELD_MAPPING_RULES = {
    # Patterns de noms de colonnes
    "identifier": {
        "patterns": ["id", "uuid", "guid", "_id", "pk"],
        "maps_to": "uuid",
    },
    "name_field": {
        "patterns": ["name", "title", "label", "heading", "subject"],
        "maps_to": "_name",
    },
    "description": {
        "patterns": ["description", "desc", "summary", "about", "bio", "excerpt"],
        "maps_to": "_description",
    },
    "content": {
        "patterns": ["content", "body", "text", "html", "markdown", "long_description"],
        "maps_to": "_content",
    },
    "price": {
        "patterns": ["price", "cost", "amount", "total", "unit_price"],
        "maps_to": "price",  # → Entity extraction
    },
    "url": {
        "patterns": ["url", "link", "href", "image", "avatar", "photo"],
        "maps_to": "url",  # → Entity extraction
    },
    "date": {
        "patterns": ["created", "updated", "deleted", "date", "timestamp", "_at"],
        "maps_to": "_metadata.{field_name}",
    },
}

def infer_mapping(table: str, column: str, dtype: str, samples: list) -> FieldMapping:
    """
    Combine heuristiques + GLiNER pour inférer le mapping.
    """
    # 1. Heuristiques basées sur le nom
    for role, config in FIELD_MAPPING_RULES.items():
        for pattern in config["patterns"]:
            if pattern in column.lower():
                return FieldMapping(
                    source=column,
                    target=config["maps_to"],
                    confidence=0.8,
                    method="heuristic",
                )

    # 2. GLiNER pour les cas ambigus
    context = f"Table '{table}', column '{column}' ({dtype}). Examples: {samples[:3]}"
    extraction = gliner.classify(context, list(FIELD_MAPPING_RULES.keys()))

    if extraction and extraction[0]["confidence"] > 0.5:
        role = extraction[0]["label"]
        return FieldMapping(
            source=column,
            target=FIELD_MAPPING_RULES[role]["maps_to"],
            confidence=extraction[0]["confidence"],
            method="gliner",
        )

    # 3. Fallback: garder le nom original
    return FieldMapping(
        source=column,
        target=column,
        confidence=0.3,
        method="passthrough",
    )
```

### Exemple concret

```sql
-- Table source
CREATE TABLE products (
    product_id UUID PRIMARY KEY,
    product_name VARCHAR(255),
    short_desc TEXT,
    full_description TEXT,
    unit_price DECIMAL(10,2),
    image_url VARCHAR(500),
    created_at TIMESTAMP,
    category_id UUID REFERENCES categories(id)
);
```

**Mapping inféré:**

| Source Column | Inferred Role | RagForge Property | Confidence | Method |
|---------------|---------------|-------------------|------------|--------|
| product_id | identifier | uuid | 0.95 | heuristic |
| product_name | name_field | _name | 0.90 | heuristic |
| short_desc | description | _description | 0.75 | gliner |
| full_description | content | _content | 0.85 | heuristic |
| unit_price | price | price (entity) | 0.90 | heuristic |
| image_url | url | url (entity) | 0.85 | heuristic |
| created_at | date | _metadata.created_at | 0.95 | heuristic |
| category_id | foreign_key | → BELONGS_TO relation | 0.90 | heuristic |

**Node résultant:**

```cypher
CREATE (p:Product {
    uuid: "...",
    _name: "Awesome Widget",
    _description: "A short description",
    _content: "Full detailed description...",
    _metadata: {created_at: "2025-01-17T..."},
    projectId: "...",
    _state: "linked"
})

// Entities extraites
MERGE (price:Entity {uuid: "entity:price:29.99", _name: "29.99", entityType: "price"})
MERGE (p)-[:MENTIONS]->(price)

// Relation FK
MATCH (c:Category {uuid: "category-uuid"})
MERGE (p)-[:BELONGS_TO]->(c)
```

---

## 4. Unified Crawler Interface

### Concept

Une interface unifiée pour tous les crawlers:

```typescript
interface Crawler<TConfig, TResult> {
    // Configuration
    configure(config: TConfig): void;

    // Discovery
    discover(): Promise<DiscoveryResult>;

    // Crawl
    crawl(options?: CrawlOptions): AsyncGenerator<CrawlProgress>;

    // Field mapping (for structured sources)
    inferMapping?(): Promise<FieldMapping[]>;
    applyMapping?(mapping: FieldMapping[]): void;

    // Results
    getStats(): CrawlStats;
}

// Implémentations
class WebCrawler implements Crawler<WebCrawlConfig, WebPage[]> { ... }
class APICrawler implements Crawler<APICrawlConfig, APIEndpoint[]> { ... }
class DatabaseCrawler implements Crawler<DBCrawlConfig, TableData[]> { ... }
```

### MCP Tools

```typescript
// Nouveaux tools MCP pour RagForge

// Web
crawl_website({ url, max_depth, max_pages, ... })
discover_links({ url })  // One-shot link discovery

// API
crawl_api({ base_url, spec_url?, auth? })
discover_endpoints({ base_url })

// Database
crawl_database({ connection_string, tables?, ... })
infer_field_mapping({ connection_string, table })
apply_field_mapping({ mapping, ... })
```

---

## 5. Priorités d'implémentation

| Crawler | Complexité | Valeur | Priorité |
|---------|------------|--------|----------|
| Web Crawler (GLiNER links) | Medium | High | 1 |
| Database Crawler + Field Mapping | High | Very High | 2 |
| API Crawler | Medium | Medium | 3 |

### Roadmap suggérée

1. **Phase 1**: Web Crawler basique avec GLiNER URL detection
2. **Phase 2**: Field Mapping inference (standalone, testable)
3. **Phase 3**: Database Crawler avec auto-mapping
4. **Phase 4**: API Crawler avec OpenAPI support

---

## 6. Deep Dives

### 6.1 Comment orienter GLiNER vers des liens spécifiques à un domaine ?

**Problème**: On ne veut pas juste extraire "url" mais "product_link", "documentation_url", "api_endpoint", etc.

**Solution 1: Entity types spécialisés**

```yaml
# Types d'URLs par contexte sémantique
link_types:
  entity_types:
    - product_url        # Lien vers une page produit
    - documentation_url  # Lien vers de la doc
    - api_endpoint       # Endpoint d'API
    - image_url          # URL d'image
    - download_url       # Lien de téléchargement
    - social_url         # Lien réseau social
    - repository_url     # Lien GitHub/GitLab
    - video_url          # Lien YouTube/Vimeo
```

**Problème**: GLiNER a besoin de contexte pour distinguer ces types.

**Solution 2: Relation extraction (RECOMMANDÉE)**

Au lieu d'extraire juste des URLs, extraire des triplets (sujet, relation, url):

```python
# Texte: "Check out our new widget at https://shop.example.com/widget-pro"
extraction = gliner.extract(
    text=content,
    entity_types=["product", "url"],
    relation_types={
        "has_product_link": "product has link to purchase page",
        "has_documentation": "concept has link to documentation",
        "has_api_endpoint": "service exposes api endpoint",
    }
)

# Résultat:
# entities: [
#   {name: "widget", type: "product"},
#   {name: "https://shop.example.com/widget-pro", type: "url"}
# ]
# relations: [
#   {subject: "widget", predicate: "has_product_link", object: "https://..."}
# ]
```

**Solution 3: Two-pass extraction**

```python
async def extract_typed_links(text: str, link_context: str) -> list[TypedLink]:
    """
    Pass 1: Extraire toutes les URLs
    Pass 2: Classifier chaque URL selon son contexte
    """
    # Pass 1: Extraction brute
    raw_extraction = await gliner.extract(
        text=text,
        entity_types=["url", "endpoint"],
    )

    typed_links = []
    for entity in raw_extraction.entities:
        if entity.type not in ["url", "endpoint"]:
            continue

        # Extraire le contexte autour du lien (±50 chars)
        context = extract_surrounding_context(text, entity.span, window=50)

        # Pass 2: Classifier le type de lien
        classification = await gliner.extract(
            text=f"Link: {entity.name}\nContext: {context}",
            entity_types=[
                "product_link",
                "documentation_link",
                "api_link",
                "media_link",
                "external_link",
            ],
        )

        link_type = classification.entities[0].type if classification.entities else "unknown"
        typed_links.append(TypedLink(
            url=entity.name,
            type=link_type,
            context=context,
            confidence=classification.entities[0].confidence if classification.entities else 0.5,
        ))

    return typed_links
```

**Solution 4: Prompt engineering avec domaine**

```python
# Injection du domaine dans la requête
def extract_links_for_domain(text: str, domain: str) -> list:
    """
    domain = "ecommerce" → focus sur product_url, price_url, cart_url
    domain = "documentation" → focus sur doc_url, api_url, example_url
    """
    domain_link_types = {
        "ecommerce": ["product_url", "category_url", "cart_url", "checkout_url"],
        "documentation": ["doc_url", "api_url", "example_url", "github_url"],
        "code": ["file_path", "import_url", "package_url", "repo_url"],
    }

    return gliner.extract(
        text=text,
        entity_types=domain_link_types.get(domain, ["url"]),
    )
```

---

### 6.2 Database: Détection des relations (FK et sémantiques)

**Approche hybride recommandée: 3 niveaux**

```
┌─────────────────────────────────────────────────────────────────┐
│              Détection de Relations - 3 Niveaux                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Niveau 1: PROGRAMMATIQUE (100% fiable)                         │
│  ─────────────────────────────────────                          │
│  → Query INFORMATION_SCHEMA.KEY_COLUMN_USAGE                    │
│  → Extraire toutes les FK définies explicitement                │
│  → Résultat: relations BELONGS_TO certaines                     │
│                                                                 │
│  Niveau 2: HEURISTIQUE (90% fiable)                             │
│  ─────────────────────────────────────                          │
│  → Pattern matching sur noms de colonnes                        │
│  → user_id → users.id, category_id → categories.id              │
│  → Vérifier que la table cible existe                           │
│  → Résultat: relations BELONGS_TO probables                     │
│                                                                 │
│  Niveau 3: SÉMANTIQUE (GLiNER, 70% fiable)                      │
│  ─────────────────────────────────────                          │
│  → Analyser les valeurs pour détecter des entités               │
│  → "author" contient des noms → lien vers users?                │
│  → "tags" contient des strings → créer Tag entities?            │
│  → Résultat: relations sémantiques inférées                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Niveau 1: Programmatique (FK explicites)**

```python
async def detect_explicit_fk(conn, table: str) -> list[Relationship]:
    """Extraire les FK depuis le schema de la DB."""
    query = """
    SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.constraint_column_usage ccu
        ON kcu.constraint_name = ccu.constraint_name
    WHERE kcu.table_name = $1
        AND kcu.constraint_name LIKE '%_fkey'
    """
    rows = await conn.fetch(query, table)

    return [
        Relationship(
            source_table=table,
            source_column=row["column_name"],
            target_table=row["foreign_table"],
            target_column=row["foreign_column"],
            type="BELONGS_TO",
            confidence=1.0,
            method="explicit_fk",
        )
        for row in rows
    ]
```

**Niveau 2: Heuristique (conventions de nommage)**

```python
FK_PATTERNS = [
    # Pattern → (target_table_transform, confidence)
    (r"^(\w+)_id$", lambda m: m.group(1) + "s", 0.9),      # user_id → users
    (r"^(\w+)_uuid$", lambda m: m.group(1) + "s", 0.9),    # order_uuid → orders
    (r"^fk_(\w+)$", lambda m: m.group(1), 0.95),           # fk_users → users
    (r"^(\w+)Id$", lambda m: m.group(1).lower() + "s", 0.85),  # userId → users (camelCase)
    (r"^parent_id$", lambda m: None, 0.8),                 # self-reference
]

async def detect_heuristic_fk(conn, table: str, columns: list[Column]) -> list[Relationship]:
    """Détecter les FK par convention de nommage."""
    # Récupérer la liste des tables existantes
    existing_tables = await get_all_tables(conn)

    relationships = []
    for col in columns:
        for pattern, table_transform, confidence in FK_PATTERNS:
            match = re.match(pattern, col.name)
            if not match:
                continue

            # Calculer le nom de table cible
            if table_transform is None:
                target_table = table  # Self-reference
            else:
                target_table = table_transform(match)

            # Vérifier que la table existe
            if target_table not in existing_tables:
                # Essayer le singulier
                singular = target_table.rstrip("s")
                if singular in existing_tables:
                    target_table = singular
                else:
                    continue

            relationships.append(Relationship(
                source_table=table,
                source_column=col.name,
                target_table=target_table,
                target_column="id",  # Assumption
                type="BELONGS_TO",
                confidence=confidence,
                method="heuristic",
            ))
            break

    return relationships
```

**Niveau 3: Sémantique (GLiNER)**

```python
async def detect_semantic_relationships(
    conn,
    table: str,
    columns: list[Column],
    sample_data: list[dict],
) -> list[Relationship]:
    """
    Utiliser GLiNER pour détecter des relations sémantiques.
    Ex: colonne "author" contient des noms de personnes → lien vers users?
    """
    relationships = []

    for col in columns:
        # Skip les colonnes déjà mappées
        if col.name.endswith("_id") or col.is_primary_key:
            continue

        # Extraire des samples
        samples = [row[col.name] for row in sample_data if row.get(col.name)][:10]
        if not samples:
            continue

        # Analyser avec GLiNER
        sample_text = "\n".join(str(s) for s in samples)
        extraction = await gliner.extract(
            text=f"Column '{col.name}' in table '{table}' contains:\n{sample_text}",
            entity_types=[
                "person_reference",    # → users table
                "product_reference",   # → products table
                "category_reference",  # → categories table
                "tag_list",            # → create Tag entities
                "json_object",         # → nested data, expand?
            ],
        )

        for entity in extraction.entities:
            if entity.confidence < 0.6:
                continue

            # Mapper le type d'entité vers une table cible
            target_mapping = {
                "person_reference": "users",
                "product_reference": "products",
                "category_reference": "categories",
            }

            target_table = target_mapping.get(entity.type)
            if target_table:
                relationships.append(Relationship(
                    source_table=table,
                    source_column=col.name,
                    target_table=target_table,
                    target_column=None,  # Match by value, not FK
                    type="REFERENCES",
                    confidence=entity.confidence,
                    method="semantic_gliner",
                    match_strategy="value_lookup",  # Lookup par valeur
                ))
            elif entity.type == "tag_list":
                # Créer des entities Tag
                relationships.append(Relationship(
                    source_table=table,
                    source_column=col.name,
                    target_table=None,  # Create entities
                    type="HAS_TAG",
                    confidence=entity.confidence,
                    method="semantic_gliner",
                    match_strategy="create_entities",
                ))

    return relationships
```

**Détection de relations many-to-many (junction tables)**

```python
def detect_junction_tables(tables: list[TableSchema]) -> list[ManyToManyRelation]:
    """
    Détecter les tables de jonction (many-to-many).
    Heuristique: table avec exactement 2 FK et peu d'autres colonnes.
    """
    junctions = []

    for table in tables:
        fk_columns = [c for c in table.columns if c.name.endswith("_id")]

        # Critères d'une junction table:
        # - Exactement 2 colonnes FK
        # - Peu d'autres colonnes (max 3: id, created_at, etc.)
        # - Nom souvent composé: "user_roles", "product_categories"
        if len(fk_columns) == 2 and len(table.columns) <= 5:
            junctions.append(ManyToManyRelation(
                junction_table=table.name,
                table_a=fk_columns[0].name.replace("_id", "s"),
                table_b=fk_columns[1].name.replace("_id", "s"),
                relation_name=f"HAS_{fk_columns[1].name.replace('_id', '').upper()}",
            ))

    return junctions
```

---

## 7. Idées ambitieuses

### 7.1 Cross-Source Entity Resolution

> **Note**: RagForge dispose DÉJÀ d'un système de déduplication d'entités dans `src/ingestion/entity-extraction/deduplication.ts`:
> - **UUID déterministe**: `entity:${type}:${normalizedName}` → automatic merge
> - **4 stratégies**: `fuzzy` (Levenshtein 0.85), `embedding` (cosine 0.9), `llm`, `hybrid`
> - **Canonical mapping**: Garde le meilleur nom (confiance > longueur > premier)
> - **Exclut les types numériques**: `price`, `date`, `quantity`, etc.
>
> Ce qui suit décrit des **améliorations cross-source** au-delà de ce qui existe.

**Problème**: La même entité existe dans **plusieurs sources différentes**:
- Web: "Apple Inc." mentionné sur une page
- API: `GET /companies/apple` retourne `{id: 123, name: "Apple"}`
- DB: `companies` table avec `company_id=456, name="Apple Inc."`

**Ce qui manque par rapport au système actuel**:
1. **Cross-source tracking**: Savoir qu'une entité vient de web + api + db
2. **SAME_AS relations**: Garder le lien vers les sources originales
3. **Attribute merging**: Fusionner les attributs de différentes sources
4. **Conflict resolution**: Gérer les valeurs contradictoires

**Solution**: Entity Resolution Pipeline (extension)

```
┌─────────────────────────────────────────────────────────────────┐
│              Cross-Source Entity Resolution                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Extraction: Chaque crawler extrait ses entités              │
│     Web  → Entity(name="Apple Inc.", source="web:page123")      │
│     API  → Entity(name="Apple", source="api:/companies/apple")  │
│     DB   → Entity(name="Apple Inc.", source="db:companies:456") │
│                                                                 │
│  2. Canonicalization: Normaliser les noms                       │
│     "Apple Inc." → "apple"                                      │
│     "Apple"      → "apple"                                      │
│     "APPLE INC"  → "apple"                                      │
│                                                                 │
│  3. Blocking: Grouper les candidats                             │
│     Même nom normalisé → même groupe                            │
│     Embeddings proches → même groupe                            │
│                                                                 │
│  4. Matching: Comparer les attributs                            │
│     GLiNER: "Are these the same entity?"                        │
│     Embeddings: cosine similarity > 0.9                         │
│     Rules: même domaine email, même adresse, etc.               │
│                                                                 │
│  5. Merging: Créer une entité canonique                         │
│     Canonical Entity avec alias et sources multiples            │
│     Relations SAME_AS vers les sources                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```python
@dataclass
class CanonicalEntity:
    uuid: str
    canonical_name: str
    entity_type: str
    aliases: list[str]
    sources: list[EntitySource]
    attributes: dict[str, Any]  # Merged from all sources
    confidence: float

# Dans Neo4j:
# (e:Entity {uuid: "canonical-123", _name: "Apple Inc."})
# (e)-[:SAME_AS {confidence: 0.95}]->(web:WebEntity {source: "web:..."})
# (e)-[:SAME_AS {confidence: 0.98}]->(api:APIEntity {source: "api:..."})
# (e)-[:SAME_AS {confidence: 1.0}]->(db:DBEntity {source: "db:..."})
```

---

### 7.2 Incremental Sync avec Change Detection

**Problème**: Re-crawler tout à chaque fois est lent et coûteux.

**Solution**: Détecter les changements et sync incrémental

```python
class IncrementalCrawler:
    """
    Stratégies de détection de changement par source:
    """

    # Web: ETag, Last-Modified, content hash
    async def detect_web_changes(self, url: str) -> ChangeStatus:
        stored = await self.get_stored_metadata(url)

        # HEAD request pour ETag/Last-Modified
        response = await self.http.head(url)

        if response.headers.get("ETag") == stored.etag:
            return ChangeStatus.UNCHANGED

        if response.headers.get("Last-Modified"):
            remote_date = parse_date(response.headers["Last-Modified"])
            if remote_date <= stored.last_modified:
                return ChangeStatus.UNCHANGED

        # Fallback: fetch et compare hash
        content = await self.fetch(url)
        if hash(content) == stored.content_hash:
            return ChangeStatus.UNCHANGED

        return ChangeStatus.CHANGED

    # API: Utiliser les endpoints de changement si disponibles
    async def detect_api_changes(self, endpoint: str) -> list[Change]:
        # Option 1: Endpoint de changements (idéal)
        # GET /changes?since=2025-01-17T00:00:00Z
        if self.api_supports_changes:
            return await self.fetch_changes(since=self.last_sync)

        # Option 2: Comparer les IDs/timestamps
        remote_items = await self.fetch_list(endpoint)
        local_items = await self.get_stored_items(endpoint)

        return self.diff_items(local_items, remote_items)

    # Database: CDC (Change Data Capture) ou polling
    async def detect_db_changes(self, table: str) -> list[Change]:
        # Option 1: CDC (Debezium, pg_logical, etc.)
        if self.cdc_enabled:
            return await self.consume_cdc_events(table)

        # Option 2: updated_at polling
        last_sync = await self.get_last_sync(table)
        query = f"SELECT * FROM {table} WHERE updated_at > $1"
        return await self.db.fetch(query, last_sync)

        # Option 3: Trigger-based (requires DB setup)
        # Option 4: Full diff (expensive but reliable)
```

---

### 7.3 Schema Evolution Tracking

**Problème**: Les schemas changent. Comment tracker et adapter?

```python
@dataclass
class SchemaVersion:
    version: int
    timestamp: datetime
    tables: dict[str, TableSchema]
    changes_from_previous: list[SchemaChange]

@dataclass
class SchemaChange:
    type: Literal["add_table", "drop_table", "add_column", "drop_column",
                  "rename_column", "change_type", "add_fk", "drop_fk"]
    table: str
    column: str | None
    details: dict

class SchemaEvolutionTracker:
    async def detect_changes(self, current: Schema, previous: Schema) -> list[SchemaChange]:
        changes = []

        # Tables ajoutées/supprimées
        added_tables = set(current.tables) - set(previous.tables)
        dropped_tables = set(previous.tables) - set(current.tables)

        for table in added_tables:
            changes.append(SchemaChange(type="add_table", table=table, ...))

        # Pour chaque table commune, comparer les colonnes
        for table in set(current.tables) & set(previous.tables):
            curr_cols = {c.name: c for c in current.tables[table].columns}
            prev_cols = {c.name: c for c in previous.tables[table].columns}

            # Colonnes ajoutées/supprimées
            for col in set(curr_cols) - set(prev_cols):
                changes.append(SchemaChange(type="add_column", table=table, column=col))

            # Colonnes modifiées
            for col in set(curr_cols) & set(prev_cols):
                if curr_cols[col].type != prev_cols[col].type:
                    changes.append(SchemaChange(type="change_type", ...))

        return changes

    async def apply_migration(self, changes: list[SchemaChange]):
        """Adapter le knowledge graph aux changements de schema."""
        for change in changes:
            if change.type == "add_column":
                # Re-crawler les données pour la nouvelle colonne
                await self.backfill_column(change.table, change.column)
            elif change.type == "drop_column":
                # Marquer les données comme obsolètes ou supprimer
                await self.mark_obsolete(change.table, change.column)
            elif change.type == "rename_column":
                # Mettre à jour le mapping
                await self.update_mapping(change.table, change.details)
```

---

### 7.4 Natural Language to Crawl Query

**Concept**: Permettre des requêtes en langage naturel pour le crawling

```
User: "Crawl all product pages from shop.example.com that cost more than $50"

→ Parsed:
  - source: web
  - seed_url: https://shop.example.com
  - filter: entity.type == "product" AND entity.price > 50
  - link_type: product_url

User: "Sync all users from the PostgreSQL database who signed up this month"

→ Parsed:
  - source: database
  - connection: postgres://...
  - table: users
  - filter: created_at >= '2025-01-01'

User: "Find all API endpoints mentioned in the GitHub README"

→ Parsed:
  - source: web
  - seed_url: https://github.com/org/repo/blob/main/README.md
  - entity_types: [endpoint, api_url]
  - max_depth: 0
```

```python
async def parse_crawl_query(query: str) -> CrawlConfig:
    """Utiliser un LLM pour parser la requête en config de crawl."""
    prompt = f"""
    Parse this crawl request into a structured config:
    "{query}"

    Output JSON with:
    - source: "web" | "api" | "database"
    - seed_url or connection_string
    - filters (if any)
    - entity_types to extract
    - max_depth, max_pages
    """

    response = await llm.complete(prompt)
    return CrawlConfig.parse_obj(json.loads(response))
```

---

### 7.5 Federated Knowledge Graph

**Concept**: Plusieurs instances RagForge qui partagent des connaissances

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ RagForge A  │     │ RagForge B  │     │ RagForge C  │
│ (Team Dev)  │────│ (Team Data) │────│ (Team Ops)  │
│             │     │             │     │             │
│ Code repos  │     │ Databases   │     │ Infra docs  │
│ API specs   │     │ Data models │     │ Runbooks    │
└─────────────┘     └─────────────┘     └─────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                    ┌───────────────┐
                    │  Federation   │
                    │    Layer      │
                    │               │
                    │ - Discovery   │
                    │ - Resolution  │
                    │ - Query fan   │
                    └───────────────┘
```

---

### 7.6 Self-Healing Data Pipeline

**Concept**: Le système détecte et corrige automatiquement les problèmes

```python
class SelfHealingPipeline:
    async def monitor_and_heal(self):
        while True:
            # Détecter les problèmes
            issues = await self.detect_issues()

            for issue in issues:
                if issue.type == "stale_data":
                    # Données pas mises à jour depuis longtemps
                    await self.trigger_recrawl(issue.source)

                elif issue.type == "broken_link":
                    # URL retourne 404
                    await self.mark_as_dead(issue.url)
                    await self.find_alternative(issue.url)

                elif issue.type == "schema_drift":
                    # Le schema source a changé
                    await self.redetect_mapping(issue.source)

                elif issue.type == "entity_conflict":
                    # Même entité avec valeurs différentes
                    await self.resolve_conflict(issue.entities)

                elif issue.type == "orphan_nodes":
                    # Nodes sans relations
                    await self.attempt_linking(issue.nodes)

            await asyncio.sleep(3600)  # Check every hour
```

---

### 7.7 Provenance & Lineage Tracking

**Concept**: Tracker l'origine de chaque donnée

```cypher
// Chaque node a un historique de provenance
(data:Entity {uuid: "..."})
  -[:DERIVED_FROM {timestamp: "...", confidence: 0.9}]->
    (source:WebPage {url: "https://..."})

(data)-[:EXTRACTED_BY {model: "gliner-v2", version: "1.0"}]->(extraction:ExtractionJob)
(data)-[:VALIDATED_BY {user: "alice", timestamp: "..."}]->(validation:HumanValidation)
(data)-[:TRANSFORMED_BY {mapping: "products-v2"}]->(transform:MappingConfig)

// Query: "D'où vient cette donnée?"
MATCH path = (e:Entity {uuid: $uuid})-[:DERIVED_FROM|EXTRACTED_BY|TRANSFORMED_BY*]->(source)
RETURN path
```

---

## 8. Questions ouvertes

1. **Storage**: Où stocker les mapping configs? YAML? Neo4j?
2. **Incremental**: Comment gérer le re-crawl incrémental?
3. **Rate limiting**: Global ou per-domain/per-endpoint?
4. **Auth**: Comment gérer les credentials de manière sécurisée?
5. **Errors**: Retry policy? Dead letter queue?

---

## 7. Références

- GLiNER2: https://github.com/urchade/GLiNER
- Scrapy (inspiration architecture): https://scrapy.org/
- OpenAPI: https://www.openapis.org/
- JSON Schema inference: https://github.com/wolverdude/GenSON
