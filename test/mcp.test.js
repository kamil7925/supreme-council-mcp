import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/config.js';
import { sampleBriefing } from './fixtures.js';

test('real stdio MCP client discovers tools, loads prompt, saves briefing, and previews without credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'council-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/server.js')],
    env: { COUNCIL_DATA_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'council-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['council_status', 'prepare_briefing', 'consult_council', 'get_consultation', 'list_consultations'].sort());
    const prompt = await client.getPrompt({ name: 'council_review', arguments: { project: 'the143rd', question: 'Review readiness' } });
    assert.ok(prompt.messages[0].content.text.includes('the143rd'));
    const saved = await client.callTool({ name: 'prepare_briefing', arguments: sampleBriefing });
    assert.ok(!saved.isError, JSON.stringify(saved));
    const { briefing_id } = JSON.parse(saved.content[0].text);
    const preview = await client.callTool({ name: 'consult_council', arguments: { briefing_id } });
    assert.ok(!preview.isError);
    assert.equal(JSON.parse(preview.content[0].text).dry_run, true);
    const duplicate = await client.callTool({ name: 'consult_council', arguments: { briefing_id, providers: ['openai', 'openai'] } });
    assert.equal(duplicate.isError, true);
    assert.ok(tools.find(tool => tool.name === 'prepare_briefing').inputSchema.properties.images);
    const imagePath = path.join(directory, 'screen.png');
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
    const visual = await client.callTool({ name: 'prepare_briefing', arguments: { ...sampleBriefing,
      images: [{ id: 'screenshot', title: 'Test image', path: imagePath }] } });
    assert.ok(!visual.isError, JSON.stringify(visual));
    const visualId = JSON.parse(visual.content[0].text).briefing_id;
    const visualPreview = await client.callTool({ name: 'consult_council', arguments: { briefing_id: visualId } });
    assert.ok(!visualPreview.isError, JSON.stringify(visualPreview));
    assert.equal(JSON.parse(visualPreview.content[0].text).image_count, 1);
    const status = await client.callTool({ name: 'council_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).server_version, '0.4.0');
    assert.ok(tools.find(tool => tool.name === 'consult_council').inputSchema.properties.profile);
    const deep = await client.callTool({ name: 'consult_council', arguments: { briefing_id: visualId, profile: 'deep' } });
    assert.ok(!deep.isError, JSON.stringify(deep));
    const deepPlan = JSON.parse(deep.content[0].text);
    assert.equal(deepPlan.profile, 'deep');
    assert.equal(deepPlan.image_count, 1);
    assert.ok(deepPlan.cost_estimate);
    const meta = await client.callTool({ name: 'consult_council', arguments: { briefing_id: visualId, profile: 'deep', providers: ['meta'] } });
    assert.ok(!meta.isError, JSON.stringify(meta));
    const metaPlan = JSON.parse(meta.content[0].text);
    assert.equal(metaPlan.members[0].provider, 'meta');
    assert.equal(metaPlan.image_count, 1);
    assert.equal(metaPlan.members[0].model, 'muse-spark-1.3');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
