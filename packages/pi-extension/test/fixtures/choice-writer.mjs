// Two independent Pi writer processes pause after their initial source/slot reads.
// Only the core vault-lock publication recheck can arbitrate the ensuing race.
import {
  answerChoice,
  reclassifyChoice,
  ChoiceRefused,
} from "../../dist/choice-answer.js";

const { root, id, revision, action } = JSON.parse(process.argv[2]);
let reads = 0;
const access = {
  root,
  scope: { project: { path: "/projects/workspace/project.md" } },
  allows: () => true,
  async assertCurrent() {
    if (++reads === 2) {
      process.send({ ready: true });
      await new Promise((resolve) => process.once("message", resolve));
    }
  },
};
try {
  const result =
    action === "answer"
      ? await answerChoice(
          access,
          { id, revision, answer: "Concurrent answer" },
          "answer-parent",
        )
      : await reclassifyChoice(
          access,
          { id, revision },
          "classification-parent",
        );
  process.send({ result });
} catch (error) {
  if (!(error instanceof ChoiceRefused)) throw error;
  process.send({ result: "refused", name: error.name });
}
process.disconnect();
