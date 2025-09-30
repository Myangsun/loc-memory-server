#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Define memory file path using environment variable with fallback
const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
// If MEMORY_FILE_PATH is just a filename, put it in the same directory as the script
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH
    ? path.isAbsolute(process.env.MEMORY_FILE_PATH)
        ? process.env.MEMORY_FILE_PATH
        : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH)
    : defaultMemoryPath;
// Location extraction utilities
class LocationExtractor {
    static extractLocations(text) {
        const matches = [];
        this.LOCATION_PATTERNS.forEach((pattern, index) => {
            let match;
            const regex = new RegExp(pattern.source, pattern.flags);
            while ((match = regex.exec(text)) !== null) {
                const locationText = match[0].trim();
                let type = 'landmark';
                if (index === 0)
                    type = 'city';
                else if (index === 1)
                    type = 'address';
                else if (index === 2)
                    type = 'landmark';
                else if (index === 3)
                    type = 'state';
                else if (index === 4)
                    type = 'country';
                matches.push({
                    text: locationText,
                    start: match.index,
                    end: match.index + locationText.length,
                    type
                });
            }
        });
        return this.deduplicateMatches(matches);
    }
    static deduplicateMatches(matches) {
        matches.sort((a, b) => a.start - b.start);
        const filtered = [];
        for (const match of matches) {
            const overlaps = filtered.some(existing => (match.start >= existing.start && match.start < existing.end) ||
                (match.end > existing.start && match.end <= existing.end));
            if (!overlaps) {
                filtered.push(match);
            }
        }
        return filtered;
    }
}
LocationExtractor.LOCATION_PATTERNS = [
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
    /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Lane|Ln)\b/gi,
    /\b(?:Mount|Mt\.?|Lake|River|Park|Bridge|University|Hospital|Airport|Station)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,
    /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming)\b/g,
    /\b(?:United\s+States|United\s+Kingdom|Canada|Mexico|France|Germany|Italy|Spain|Japan|China|India|Australia|Brazil|Argentina)\b/g
];
// Knowledge Graph Manager
class KnowledgeGraphManager {
    async loadGraph() {
        try {
            const data = await fs.readFile(MEMORY_FILE_PATH, "utf-8");
            const lines = data.split("\n").filter(line => line.trim() !== "");
            return lines.reduce((graph, line) => {
                const item = JSON.parse(line);
                if (item.type === "entity")
                    graph.entities.push(item);
                if (item.type === "relation")
                    graph.relations.push(item);
                return graph;
            }, { entities: [], relations: [] });
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === "ENOENT") {
                return { entities: [], relations: [] };
            }
            throw error;
        }
    }
    async saveGraph(graph) {
        const lines = [
            ...graph.entities.map(e => JSON.stringify({
                type: "entity",
                name: e.name,
                entityType: e.entityType,
                observations: e.observations
            })),
            ...graph.relations.map(r => JSON.stringify({
                type: "relation",
                from: r.from,
                to: r.to,
                relationType: r.relationType
            })),
        ];
        await fs.writeFile(MEMORY_FILE_PATH, lines.join("\n"));
    }
    async createEntities(entities) {
        const graph = await this.loadGraph();
        const newEntities = entities.filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name));
        graph.entities.push(...newEntities);
        await this.saveGraph(graph);
        return newEntities;
    }
    async createRelations(relations) {
        const graph = await this.loadGraph();
        const newRelations = relations.filter(r => !graph.relations.some(existingRelation => existingRelation.from === r.from &&
            existingRelation.to === r.to &&
            existingRelation.relationType === r.relationType));
        graph.relations.push(...newRelations);
        await this.saveGraph(graph);
        return newRelations;
    }
    async addObservations(observations) {
        const graph = await this.loadGraph();
        const results = observations.map(o => {
            const entity = graph.entities.find(e => e.name === o.entityName);
            if (!entity) {
                throw new Error(`Entity with name ${o.entityName} not found`);
            }
            const newObservations = o.contents.filter(content => !entity.observations.includes(content));
            entity.observations.push(...newObservations);
            return { entityName: o.entityName, addedObservations: newObservations };
        });
        await this.saveGraph(graph);
        return results;
    }
    async deleteEntities(entityNames) {
        const graph = await this.loadGraph();
        graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
        graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
        await this.saveGraph(graph);
    }
    async deleteObservations(deletions) {
        const graph = await this.loadGraph();
        deletions.forEach(d => {
            const entity = graph.entities.find(e => e.name === d.entityName);
            if (entity) {
                entity.observations = entity.observations.filter(o => !d.observations.includes(o));
            }
        });
        await this.saveGraph(graph);
    }
    async deleteRelations(relations) {
        const graph = await this.loadGraph();
        graph.relations = graph.relations.filter(r => !relations.some(delRelation => r.from === delRelation.from &&
            r.to === delRelation.to &&
            r.relationType === delRelation.relationType));
        await this.saveGraph(graph);
    }
    async readGraph() {
        return this.loadGraph();
    }
    async searchNodes(query) {
        const graph = await this.loadGraph();
        const filteredEntities = graph.entities.filter(e => e.name.toLowerCase().includes(query.toLowerCase()) ||
            e.entityType.toLowerCase().includes(query.toLowerCase()) ||
            e.observations.some(o => o.toLowerCase().includes(query.toLowerCase())));
        const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
        const filteredRelations = graph.relations.filter(r => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to));
        return {
            entities: filteredEntities,
            relations: filteredRelations,
        };
    }
    async openNodes(names) {
        const graph = await this.loadGraph();
        const filteredEntities = graph.entities.filter(e => names.includes(e.name));
        const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
        const filteredRelations = graph.relations.filter(r => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to));
        return {
            entities: filteredEntities,
            relations: filteredRelations,
        };
    }
    async extractAndAddLocations(text, sourceEntity) {
        const locations = LocationExtractor.extractLocations(text);
        const newEntities = [];
        const newRelations = [];
        for (const location of locations) {
            const locationEntity = {
                name: location.text,
                entityType: 'location',
                observations: [
                    `Location type: ${location.type}`,
                    `Extracted from text: "${text.substring(Math.max(0, location.start - 20), Math.min(text.length, location.end + 20))}"`,
                    `Original context: positions ${location.start}-${location.end}`
                ]
            };
            newEntities.push(locationEntity);
            if (sourceEntity) {
                const relation = {
                    from: sourceEntity,
                    to: location.text,
                    relationType: 'mentions_location'
                };
                newRelations.push(relation);
            }
            if (location.type === 'city' && location.text.includes(',')) {
                const parts = location.text.split(',').map(p => p.trim());
                if (parts.length === 2) {
                    const [city, stateOrCountry] = parts;
                    const parentEntity = {
                        name: stateOrCountry,
                        entityType: 'location',
                        observations: [
                            `Location type: ${stateOrCountry.length <= 3 ? 'state' : 'country'}`,
                            `Parent location of: ${city}`
                        ]
                    };
                    newEntities.push(parentEntity);
                    const hierarchyRelation = {
                        from: city,
                        to: stateOrCountry,
                        relationType: 'located_in'
                    };
                    newRelations.push(hierarchyRelation);
                }
            }
        }
        const createdEntities = await this.createEntities(newEntities);
        const createdRelations = await this.createRelations(newRelations);
        return {
            entities: createdEntities,
            relations: createdRelations
        };
    }
}
// Create server instance
const knowledgeGraphManager = new KnowledgeGraphManager();
const server = new McpServer({
    name: "memory-server",
    version: "0.6.3",
});
// Register tools
server.tool("create_entities", "Create multiple new entities in the knowledge graph", {
    entities: {
        type: "array",
        items: {
            type: "object",
            properties: {
                name: { type: "string", description: "The name of the entity" },
                entityType: { type: "string", description: "The type of the entity" },
                observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents associated with the entity"
                },
            },
            required: ["name", "entityType", "observations"],
        },
    },
}, async ({ entities }) => {
    const result = await knowledgeGraphManager.createEntities(entities);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("create_relations", "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice", {
    relations: {
        type: "array",
        items: {
            type: "object",
            properties: {
                from: { type: "string", description: "The name of the entity where the relation starts" },
                to: { type: "string", description: "The name of the entity where the relation ends" },
                relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
        },
    },
}, async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelations(relations);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("add_observations", "Add new observations to existing entities in the knowledge graph", {
    observations: {
        type: "array",
        items: {
            type: "object",
            properties: {
                entityName: { type: "string", description: "The name of the entity to add the observations to" },
                contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add"
                },
            },
            required: ["entityName", "contents"],
        },
    },
}, async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservations(observations);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("delete_entities", "Delete multiple entities and their associated relations from the knowledge graph", {
    entityNames: {
        type: "array",
        items: { type: "string" },
        description: "An array of entity names to delete"
    },
}, async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    return { content: [{ type: "text", text: "Entities deleted successfully" }] };
});
server.tool("delete_observations", "Delete specific observations from entities in the knowledge graph", {
    deletions: {
        type: "array",
        items: {
            type: "object",
            properties: {
                entityName: { type: "string", description: "The name of the entity containing the observations" },
                observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observations to delete"
                },
            },
            required: ["entityName", "observations"],
        },
    },
}, async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    return { content: [{ type: "text", text: "Observations deleted successfully" }] };
});
server.tool("delete_relations", "Delete multiple relations from the knowledge graph", {
    relations: {
        type: "array",
        items: {
            type: "object",
            properties: {
                from: { type: "string", description: "The name of the entity where the relation starts" },
                to: { type: "string", description: "The name of the entity where the relation ends" },
                relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
        },
        description: "An array of relations to delete"
    },
}, async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    return { content: [{ type: "text", text: "Relations deleted successfully" }] };
});
server.tool("read_graph", "Read the entire knowledge graph", {}, async () => {
    const result = await knowledgeGraphManager.readGraph();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("search_nodes", "Search for nodes in the knowledge graph based on a query", {
    query: { type: "string", description: "The search query to match against entity names, types, and observation content" },
}, async ({ query }) => {
    const result = await knowledgeGraphManager.searchNodes(query);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("open_nodes", "Open specific nodes in the knowledge graph by their names", {
    names: {
        type: "array",
        items: { type: "string" },
        description: "An array of entity names to retrieve",
    },
}, async ({ names }) => {
    const result = await knowledgeGraphManager.openNodes(names);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
server.tool("extract_locations", "Extract locations from text and add them to the knowledge graph as entities with geographic relationships", {
    text: {
        type: "string",
        description: "The text to extract locations from"
    },
    sourceEntity: {
        type: "string",
        description: "Optional: name of source entity that mentions these locations (creates 'mentions_location' relations)"
    },
}, async ({ text, sourceEntity }) => {
    const result = await knowledgeGraphManager.extractAndAddLocations(text, sourceEntity);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
// Start HTTP server
const app = express();
const port = parseInt(process.env.PORT || '8081');
// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
app.use(express.json());
// MCP endpoint
app.post('/mcp', async (req, res) => {
    console.error(`[${new Date().toISOString()}] MCP POST request`);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => Math.random().toString(36).substring(7),
        enableDnsRebindingProtection: false,
    });
    await transport.connect(server);
    await transport.handleRequest(req, res);
});
// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
app.listen(port, () => {
    console.error(`MCP Server listening on port ${port}`);
    console.error(`Endpoint: http://localhost:${port}/mcp`);
});
//# sourceMappingURL=server.js.map