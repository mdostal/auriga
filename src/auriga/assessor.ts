import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_REGISTRY } from './registry.ts';

export interface AssessedState {
  projectName: string;
  deliveredFeatures: string[];
  missingGaps: string[];
}

export class ProjectAssessor {
  /**
   * Assesses the current state of a project by reading its Gap Map, README,
   * and completed tickets (if passed or fetched).
   * For the mock implementation, we rely on extracting keywords from the Gap Map file.
   */
  assessProject(projectName: string): AssessedState | null {
    const project = PROJECT_REGISTRY.find(p => p.name === projectName);
    if (!project) {
      return null;
    }

    const gapMapPath = join(project.workspacePath, 'GapMap.md');
    let gapMapContent = '';

    if (existsSync(gapMapPath)) {
      gapMapContent = readFileSync(gapMapPath, 'utf8');
    }

    // A forgiving parser relying on keyword extraction or basic regex, per risks mitigation.
    return this.parseGapMap(projectName, gapMapContent);
  }

  /**
   * Parses the Gap Map text into delivered features and missing gaps.
   */
  parseGapMap(projectName: string, content: string): AssessedState {
    const deliveredFeatures: string[] = [];
    const missingGaps: string[] = [];

    const lines = content.split('\n');
    let currentSection: 'delivered' | 'missing' | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const lowerLine = trimmed.toLowerCase();
      
      if (lowerLine.includes('delivered') || lowerLine.includes('completed') || lowerLine.includes('done')) {
        currentSection = 'delivered';
        continue;
      }
      
      if (lowerLine.includes('missing') || lowerLine.includes('gap') || lowerLine.includes('todo') || lowerLine.includes('pending')) {
        currentSection = 'missing';
        continue;
      }

      // If it looks like a list item
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        const item = trimmed.replace(/^[-*]\s*/, '').trim();
        if (currentSection === 'delivered') {
          deliveredFeatures.push(item);
        } else if (currentSection === 'missing') {
          missingGaps.push(item);
        }
      }
    }

    return {
      projectName,
      deliveredFeatures,
      missingGaps
    };
  }
}
