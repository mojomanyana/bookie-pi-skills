// An operator can leave a question open, choose a supplied option or type an answer.
// Drive the same key handler, authenticated session connection and renderer as the terminal.
import assert from "node:assert/strict";

const materials = {
  title: "Map Room materials",
  summary: "Workshop brief: practise finding places with grid references.",
  openChoice: "Which map should participants use?",
  choiceOptions: [
    "Topographic sheet",
    "Street atlas",
    "Transit map",
    "Trail map",
  ],
  choiceRecommendation: {
    option: "Street atlas",
    reason: "An indexed atlas gives each pair a grid-reference exercise.",
    evidence: "practise finding places with grid references",
  },
};
const chartQuestion =
  "Which chart: the StarDome foldout or a local planisphere?";
const ownAnswer = "Borrow the library's tactile chart.";

export function choiceTurn(prompt, results, { call, say, text }) {
  if (prompt === "Prepare the Map Room materials decision.") {
    if (!results.length) return call("bookie_remember", materials);
    assert.equal(JSON.parse(text(results[0].content)).status, "saved");
    return say("Workshop materials left open.");
  }
  const title =
    prompt === "Recall our Map Room materials decision."
      ? materials.title
      : prompt === "Recall our Workshop guide decision."
        ? "Workshop guide"
        : undefined;
  if (!title) return;
  if (!results.length) return call("bookie_search", { query: title });
  const search = JSON.parse(text(results[0].content)).result;
  assert.equal(search.complete, true);
  const source = search.results.find((r) => r.source.path.includes("/note-"));
  const receipt = search.results.find((r) =>
    r.source.path.includes("/answer-"),
  );
  assert.ok(source, "Missing original note for " + title);
  assert.ok(receipt, "Missing decision receipt for " + title);
  if (results.length === 1)
    return call("bookie_read", { selector: "uid", value: source.uid });
  if (results.length === 2)
    return call("bookie_read", { selector: "uid", value: receipt.uid });
  const answer = JSON.parse(text(results[1].content)).result.choiceResolution
    ?.answer;
  assert.ok(answer, "No recorded resolution on the original note");
  assert.ok(
    JSON.parse(text(results[2].content)).result.sourceText.includes(answer),
    "Separate decision receipt does not agree with the original note's current resolution",
  );
  return say(answer);
}

// Invoked inside the real parent in the private test workspace.
export async function pressChoice(command, connection, controls, render) {
  await connection.refresh();
  const screen = controls.screen;
  const draw = () =>
    render({
      width: 88,
      height: 32,
      connected: true,
      items: [],
      session: connection.state.snapshot,
      screen,
    });
  draw();
  const question = command === "custom" ? chartQuestion : materials.openChoice;
  const item = screen.items.find((i) => i.label === question);
  assert.ok(item, "Missing open row: " + question);
  screen.selectedKey = item.key;
  draw();
  assert.equal(controls.key("return"), "inspect-choice");
  await controls.inspect();
  const picker = screen.picker;
  assert.equal(picker?.phase, "options", picker?.error);
  const frame = draw();
  const expected = command === "custom" ? [] : materials.choiceOptions;
  assert.deepEqual(picker.detail.options, expected);
  if (expected.length) {
    assert.ok(frame.includes("Recommended"));
    assert.ok(frame.includes(materials.choiceRecommendation.reason));
    assert.ok(frame.includes(materials.choiceRecommendation.evidence));
  } else assert.equal(picker.detail.recommendation, undefined);
  const downCount =
    command === "later" ? expected.length + 1 : command === "pick" ? 1 : 0;
  for (let i = 0; i < downCount; i++) controls.key("down");
  controls.key("return");
  if (command === "later") {
    assert.equal(screen.view, "main");
    return "deferred";
  }
  if (command === "custom") {
    assert.equal(picker.phase, "custom");
    for (const char of ownAnswer) controls.key(char, char);
    controls.key("return");
  }
  assert.equal(picker.phase, "confirm");
  assert.ok(draw().includes(command === "custom" ? ownAnswer : expected[1]));
  assert.equal(controls.key("return"), "answer-choice");
  await controls.save();
  assert.equal(picker.phase, "saved", picker.error);
  assert.ok(draw().includes("Answer saved in Bookie."));
  return "saved";
}

export async function verifyAnswers({ host, notifications, frame, text }) {
  const fresh = async () => {
    const id = host.session.sessionManager.getSessionId();
    assert.deepEqual(await host.newSession(), { cancelled: false });
    assert.notEqual(host.session.sessionManager.getSessionId(), id);
    assert.deepEqual(host.session.messages, []);
  };
  const press = async (command, expected) => {
    notifications.length = 0;
    await host.session.prompt("/workshop-choice " + command);
    assert.equal(notifications.at(-1), expected);
  };
  const visible = async (expected) => {
    for (const destination of ["now", "work"]) {
      const view = await frame(destination, expected[0] ?? "Bookie memory");
      for (const question of [materials.openChoice, chartQuestion])
        assert.equal(
          view.includes(question),
          expected.includes(question),
          view,
        );
      assert.doesNotMatch(
        view,
        /Needs attention|Needs your (?:decision|permission|input)/i,
      );
    }
  };
  await host.session.prompt("Prepare the Map Room materials decision.");
  await visible([materials.openChoice, chartQuestion]);
  await press("later", "deferred");
  await fresh();
  await visible([materials.openChoice, chartQuestion]);
  await press("pick", "saved");
  await visible([chartQuestion]);
  await fresh();
  await visible([chartQuestion]);
  await host.session.prompt("Recall our Map Room materials decision.");
  assert.equal(
    text(host.session.messages.at(-1).content),
    materials.choiceOptions[1],
  );
  await press("custom", "saved");
  await fresh();
  await visible([]);
  await host.session.prompt("Recall our Workshop guide decision.");
  assert.equal(text(host.session.messages.at(-1).content), ownAnswer);
  return {
    decideLater: "both choices stayed open",
    selectedAnswer: materials.choiceOptions[1],
    writtenAnswer: ownAnswer,
    freshSessions: 3,
    attentionRequests: 0,
  };
}
