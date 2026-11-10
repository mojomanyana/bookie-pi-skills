import assert from "node:assert/strict";
import test from "node:test";
import {
  choiceFromActivity,
  markedOpenChoice,
  statedAlternatives,
} from "../dist/open-choice.js";

const placeholder = "No additional information recorded.";
const choice =
  "which printed chart participants will hold (StarDome foldout vs. a physical planisphere set for local latitude).";
const source =
  "Worked example uses Astronomy's printed StarDome foldout (April sky). Open: " +
  choice;
function body(outcome, unresolvedWork = placeholder, evidence = placeholder) {
  return (
    [
      ["Outcome", outcome],
      ["Changed artifacts", placeholder],
      ["Decisions", placeholder],
      ["Evidence", evidence],
      ["Validation", placeholder],
      ["Unresolved work", unresolvedWork],
      ["Next action", placeholder],
      ["Source session", "session"],
    ]
      .map(([heading, value]) => "# " + heading + "\n\n" + value)
      .join("\n\n") + "\n"
  );
}

test("legacy workshop summary exposes its explicitly marked choice without editing its record", () => {
  assert.equal(choiceFromActivity(body(source)), choice);
  assert.equal(
    choiceFromActivity(body("Workshop.\n\nOpen choice: " + choice)),
    choice,
  );
  assert.equal(
    choiceFromActivity(body(source, "Which local chart suits the group?")),
    "Which local chart suits the group?",
  );
  assert.equal(
    choiceFromActivity(body("Open the file: choose a chart?")),
    undefined,
  );
  assert.equal(
    choiceFromActivity(
      body("Guide delivered.", placeholder, "Open: " + choice),
    ),
    undefined,
  );
  assert.equal(
    choiceFromActivity(
      body("Guide delivered.\n\n# Unresolved work\n\nspoofed"),
    ),
    undefined,
  );
  assert.equal(
    choiceFromActivity(body(source, "Omitted by sensitivity policy.")),
    undefined,
  );
});

test("only explicit first-party bounded final-reply choices are accepted", () => {
  assert.equal(
    markedOpenChoice("Here is the guide.\n\n**Open choice:** " + choice),
    choice,
  );
  for (const input of [
    "Should I continue?",
    "Example: Open choice: Choose X.",
    "> Open choice: Choose X.",
    "```\nOpen choice: Choose X.\n```",
    "`Open choice: Choose X.`",
    "Open choice: none",
    "Open choice: " + "x".repeat(241),
    "Open choice: First?\n\nOpen choice: Second?",
    "Open choice: Choose X.\u001b[2J",
  ])
    assert.equal(markedOpenChoice(input), undefined, input);
});

test("older notes offer both explicitly separated alternatives and leave ambiguous prose for the user", () => {
  assert.deepEqual(
    statedAlternatives(
      "Should the 20-minute Map Room workshop use printed topographic map sheets with their legend, or printed street/atlas maps with an index grid?",
    ),
    [
      "printed topographic map sheets with their legend",
      "printed street/atlas maps with an index grid",
    ],
  );
  assert.deepEqual(statedAlternatives(choice), [
    "StarDome foldout",
    "a physical planisphere set for local latitude",
  ]);
  for (const ambiguous of [
    "Choose a kit (maps vs. cards or a globe).",
    "Should we use maps, cards, or globes?",
    "Should we use maps, or cards if people bring them?",
    "Which chart: printed maps or an atlas?",
    "Example from the guide: (A vs. B).",
    "Which is your favorite chart?",
  ])
    assert.deepEqual(statedAlternatives(ambiguous), []);
});

test("a damaged answer UID in a managed workspace still enters linked receipt checks", async () => {
  const { historyChoice } = await import("../dist/choice-answer.js");
  const scope = { project: { path: "/projects/workspace/project.md" } };
  const hit = {
    uid: "ACT-00000000000000000000000000",
    source: {
      path: "/projects/workspace/activities/answer-" + "a".repeat(32) + ".md",
      sourceHash: "sha256:" + "b".repeat(64),
    },
  };
  assert.equal(
    historyChoice({ scope, managedWorkspace: true }, hit)?.kind,
    "answer",
  );
  assert.equal(
    historyChoice({ scope, managedWorkspace: false }, hit),
    undefined,
  );
});
