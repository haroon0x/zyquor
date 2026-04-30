import { createLocalRepository } from "../packages/storage/dist/index.js";

async function reset() {
  const repo = await createLocalRepository();

  const packets = await repo.listSourcePackets();
  console.log(`Found ${packets.length} source packets`);

  let deleted = 0;
  for (const p of packets) {
    if (p.summary.includes('[useful_info]') || p.summary.includes('Distill this article')) {
      console.log(`Deleting: ${p.title.slice(0, 60)}`);
      await repo.deleteSourcePacket(p.id);
      deleted++;
    }
  }

  console.log(`Deleted ${deleted} corrupted packets`);
}

reset().catch(console.error);
