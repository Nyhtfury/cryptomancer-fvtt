import {
  ParsedRollResult,
  SkillCheckConfigFlag,
} from "./skill-check.interface";
import {
  CheckDifficulty,
  CheckDifficultyLabel,
  CheckResult,
  CheckResultLabel,
  DieResult,
  DieType,
} from "./skill-check.enum";
import { getGame, l } from "../shared/util";
import type { ChatMessageDataConstructorData } from "@league-of-foundry-developers/foundry-vtt-types/src/foundry/common/data/data.mjs/chatMessageData";

/**
 * Executes skill checks from character sheets, creates
 * chat cards for those skill checks, and updates
 * existing chat cards for previous skill checks.
 */
export class SkillCheckService {
  /**
   * Do a skill check. Rolls dice, creates a chat card.
   */
  static async skillCheck(
    attributeDice: number,
    attributeName = "",
    difficulty = CheckDifficulty.Challenging,
    skillName = "",
    skillBreak = false,
    skillPush = false
  ): Promise<void> {
    const r = new Roll(
      `{${Math.max(attributeDice, 0)}d10, ${Math.max(5 - attributeDice, 0)}d6}`,
      {}
    );
    await r.evaluate({ async: true });
    await this.createChatMessage(
      r,
      attributeName,
      skillName,
      difficulty,
      skillBreak,
      skillPush
    );
  }

  /**
   * Given a xd10, yd6 roll, the difficulty, and break/push for this skill,
   * returns the values of the dice for rendering as well as the final result
   * of the skill check
   */
  static getCheckResult(
    roll: Roll,
    difficulty: CheckDifficulty,
    skillBreak: boolean,
    skillPush: boolean
  ): { parsedDice: ParsedRollResult[]; result: CheckResult } {
    // Separate dice
    const attributeRoll = (roll.terms[0] as PoolTerm).rolls[0];
    const fateRoll = (roll.terms[0] as PoolTerm).rolls[1];

    // Get dice results
    const parsedDice: ParsedRollResult[] = [
      ...this.parseRoll(attributeRoll, DieType.Attribute, difficulty),
      ...this.parseRoll(fateRoll, DieType.Fate, difficulty),
    ];

    // Get number of hits/botches
    let skillBreakUsed = false;
    let hit = 0;
    let botch = 0;
    parsedDice.forEach((parsed) => {
      if (parsed.result === DieResult.Botch && skillBreak && !skillBreakUsed) {
        parsed.result = DieResult.Hit;
        parsed.break = true;
        skillBreakUsed = true;
      } else if (
        parsed.type === DieType.Attribute &&
        parsed.value === 10 &&
        skillPush
      ) {
        parsed.push = true;
      }
      if (parsed.push) {
        hit += 2;
      } else if (parsed.result === DieResult.Botch) {
        botch += 1;
      } else if (parsed.result === DieResult.Hit) {
        hit += 1;
      }
    });

    const result = this.calculateCheckResult(hit, botch);

    return { parsedDice, result };
  }

  /**
   * Convert a set of rolled dice to a format that can more
   * easily be rendered.
   */
  private static parseRoll(
    roll: Roll,
    rollType: DieType,
    difficulty: CheckDifficulty
  ): ParsedRollResult[] {
    const result: ParsedRollResult[] = [];

    (roll.terms[0] as DiceTerm).results.forEach((r) => {
      const parsed: ParsedRollResult = {
        break: false,
        push: false,
        value: r.result,
        result: this.getDieResult(r.result, rollType, difficulty),
        type: rollType,
      };
      result.push(parsed);
    });

    return result;
  }

  /**
   * Gets the result of an individual die based on its value,
   * type, and the difficulty of the check.
   */
  private static getDieResult(
    value: number,
    dieType: DieType,
    difficulty: CheckDifficulty
  ): DieResult {
    if (value === 1) {
      return DieResult.Botch;
    } else if (value === 10 || (dieType === DieType.Fate && value === 6)) {
      return DieResult.Hit;
    } else if (dieType === DieType.Attribute && value >= difficulty) {
      return DieResult.Hit;
    } else {
      return DieResult.None;
    }
  }

  /**
   * Counts hits and botches and returns the result.
   */
  private static calculateCheckResult(hit: number, botch: number): CheckResult {
    const value = hit - botch;
    switch (value) {
      case CheckResult.SolidFailure:
        return CheckResult.SolidFailure;
      case CheckResult.AlmostHadIt:
        return CheckResult.AlmostHadIt;
      case CheckResult.JustBarely:
        return CheckResult.JustBarely;
      case CheckResult.SolidSuccess:
        return CheckResult.SolidSuccess;
      default:
        if (value <= CheckResult.DramaticFailure) {
          return CheckResult.DramaticFailure;
        }
        return CheckResult.DramaticSuccess;
    }
  }

  /**
   * Create a new chat message for a skill check.
   */
  static async createChatMessage(
    roll: Roll,
    attribute: string,
    skill: string,
    difficulty: CheckDifficulty,
    skillBreak: boolean,
    skillPush: boolean
  ) {
    // Gather message data
    const data = await this.getChatMessageData(
      roll,
      attribute,
      skill,
      difficulty,
      skillBreak,
      skillPush
    );

    const messageData: ChatMessageDataConstructorData = {
      ...data,
      user: getGame().user?.id,
      speaker: ChatMessage.getSpeaker(),
      roll,
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      sound: CONFIG.sounds.dice,
      whisper: null,
    };

    // Get roll mode
    const rollMode = getGame().settings.get("core", "rollMode");
    if (["gmroll", "blindroll"].includes(rollMode)) {
      messageData.whisper = ChatMessage.getWhisperRecipients("GM");
    }

    // Create message
    return ChatMessage.create(messageData, {});
  }

  /**
   * Update an existing chat message for a skill check. Args are
   * the message itself and the new values for the message.
   */
  static async updateChatMessage(
    message: ChatMessage,
    overrideConfig: Partial<SkillCheckConfigFlag>
  ) {
    // Get config
    const config = message.getFlag(
      "cryptomancer",
      "check-config"
    ) as SkillCheckConfigFlag;
    if (!config || !message.roll) {
      return;
    }

    const combinedConfig = { ...config, ...overrideConfig };

    // Get new data
    const messageData = await this.getChatMessageData(
      message.roll,
      combinedConfig.attribute,
      combinedConfig.skill,
      combinedConfig.difficulty,
      combinedConfig.skillBreak,
      combinedConfig.skillPush
    );

    return message.update(messageData, {});
  }

  /**
   * Given the config for a chat message, gets the content of
   * the message and stores the config as a flag.
   */
  private static async getChatMessageData(
    roll: Roll,
    attribute: string,
    skill: string,
    difficulty: CheckDifficulty,
    skillBreak: boolean,
    skillPush: boolean
  ) {
    // Get result
    const result = this.getCheckResult(roll, difficulty, skillBreak, skillPush);

    // Get labels for chat message
    const labels = {
      attributeName: attribute ? l(`Attr.${attribute}`) : "",
      skillName: skill ? l(`Skill.${skill}`) : "",
      difficulty: l(`CheckDifficulty.${CheckDifficultyLabel[difficulty]}`),
      checkResult: l(`CheckResult.${CheckResultLabel[result.result]}`),
      resultDescription: l(
        `CheckResultDescription.${CheckResultLabel[result.result]}`
      ),
    };

    // Render template
    const resultTemplate = await renderTemplate(
      "systems/cryptomancer/skill-check/skill-check.hbs",
      { rolls: result.parsedDice, ...labels, difficultyValue: difficulty }
    );

    const messageData = {
      content: resultTemplate,
      flags: {
        cryptomancer: {
          "check-config": {
            attribute,
            skill,
            difficulty,
            skillBreak,
            skillPush,
          },
        },
      },
    };

    return messageData;
  }

  /**
   * Add event listeners to buttons on chat card
   */
  static bindMessage(message: ChatMessage, html: JQuery<HTMLElement>): void {
    if (!message.id) {
      return;
    }

    const id = message.id;

    html
      .find(".difficulty-update-button")
      .off()
      .on("click", (evt) => {
        const _message = getGame().messages?.get(id);
        if (_message) {
          if (evt.target.classList.contains("left")) {
            this.lowerDifficulty(_message);
          } else {
            this.raiseDifficulty(_message);
          }
        }
      });
  }

  /**
   * Lower the difficulty and re-render
   */
  private static lowerDifficulty(message: ChatMessage): void {
    const config = message.getFlag(
      "cryptomancer",
      "check-config"
    ) as SkillCheckConfigFlag;
    if (!config) {
      return;
    }
    const overrideConfig: Partial<SkillCheckConfigFlag> = {};
    switch (config.difficulty) {
      case CheckDifficulty.Tough:
        overrideConfig.difficulty = CheckDifficulty.Challenging;
        break;
      case CheckDifficulty.Challenging:
        overrideConfig.difficulty = CheckDifficulty.Trivial;
        break;
    }
    this.updateChatMessage(message, overrideConfig);
  }

  /**
   * Raise the difficulty and re-render
   */
  private static raiseDifficulty(message: ChatMessage): void {
    const config = message.getFlag(
      "cryptomancer",
      "check-config"
    ) as SkillCheckConfigFlag;
    if (!config) {
      return;
    }
    const overrideConfig: Partial<SkillCheckConfigFlag> = {};
    switch (config.difficulty) {
      case CheckDifficulty.Trivial:
        overrideConfig.difficulty = CheckDifficulty.Challenging;
        break;
      case CheckDifficulty.Challenging:
        overrideConfig.difficulty = CheckDifficulty.Tough;
        break;
    }
    this.updateChatMessage(message, overrideConfig);
  }
}
