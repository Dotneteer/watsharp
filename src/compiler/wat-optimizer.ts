import {
  add,
  branch,
  branchIf,
  constVal,
  FunctionBuilder,
  localTee,
  sub,
} from "../wa-ast/FunctionBuilder";
import {
  Block,
  Branch,
  BranchIf,
  ConstVal,
  If,
  LocalGet,
  LocalSet,
  LocalTee,
  Loop,
  Store,
  WaBitSpec,
  WaInstruction,
  WaType,
} from "../wa-ast/wa-nodes";
import {
  findInstruction,
  instructionsActionLoop,
  visitInstructions,
} from "./wat-helpers";

/**
 * Optimizes the specified set of instructions
 * @param instrs WA instructions to optimize
 */
export function optimizeWat(instrs: WaInstruction[]): void {
  let changeCount: number;
  do {
    changeCount = 0;
    changeCount += removeDeadCode(instrs);
    changeCount += convertToBranchIf(instrs);
    changeCount += removeRedundantBranch(instrs);
    changeCount += reduceBranchIf(instrs);
    changeCount += optimizeConstantOperations(instrs);
    changeCount += reduceIntegerCasts(instrs);
    changeCount += optimizeLocalAccessors(instrs);
    changeCount += optimizeLocalTees(instrs);
    changeCount += optimizeStoreOps(instrs);
    changeCount += optimizeConstantDuplication(instrs);
    changeCount += optimizeEmptyLoop(instrs);
    changeCount += optimizeEmptyBlock(instrs);
    changeCount += peelLoop(instrs);
    changeCount += peelBlock(instrs);
  } while (changeCount);
}

/**
 * Optimizes constants
 * @param instrs WA instructions to optimize
 */
export function optimizeConstants(instrs: WaInstruction[]): void {
  let changeCount: number;
  do {
    changeCount = optimizeConstantOperations(instrs);
  } while (changeCount);
}

/**
 * Optimizes local usages
 * @param funcBuilder Builder to optimize
 */
export function optimizeLocalUsage(funcBuilder: FunctionBuilder): void {
  const localUsages = new Set<string>();
  visitInstructions(funcBuilder.body, (ins) => {
    if (ins.type.startsWith("Local")) {
      localUsages.add((ins as LocalGet).id);
    }
  });
  funcBuilder.locals = funcBuilder.locals.filter((l) => localUsages.has(l.id));
}

/**
 * Optimizes the usage of the last inline parameter
 * @param builderBody Body to optimize
 * @param paramName Name of the last inline parameter
 * @param startIndex Start index of the inline invocation
 */
export function optimizeLastInlineParam(
  builderBody: WaInstruction[],
  paramName: string,
  startIndex: number
): void {
  // --- No inline parameter
  if (!paramName) {
    return;
  }

  // --- Let's count the getters for the last param
  const maxLength = builderBody.length;
  let getters = 0;
  let getterParent: WaInstruction[] | undefined;
  let getterIndex = -1;
  visitInstructions(
    builderBody,
    (ins, parent, index) => {
      if (ins.type === "LocalGet" && ins.id === paramName) {
        getters++;
        getterParent = parent;
        getterIndex = index;
      }
    },
    startIndex
  );

  // --- Multiple getters, no optimization
  if (getters > 1 || getterIndex < 0 || !getterParent) {
    return;
  }

  // --- Check for replaceable pattern (constVal, localGet, globalGet)
  if (
    (builderBody[startIndex].type === "ConstVal" ||
      builderBody[startIndex].type === "LocalGet" ||
      builderBody[startIndex].type === "GlobalGet") &&
    startIndex + 1 < maxLength &&
    builderBody[startIndex + 1].type === "LocalSet" &&
    (builderBody[startIndex + 1] as LocalSet).id === paramName &&
    (getterParent[getterIndex] as LocalGet).id === paramName
  ) {
    // --- Replace the getter with the constant
    getterParent[getterIndex] = builderBody[startIndex];

    // --- Remove the constant and the setter
    builderBody.splice(startIndex, 2);
  }
}

/**
 * Removes constant operations and replaces them with their equivalent
 * constant value
 * @param instrs WA instructions to optimize
 */
function optimizeConstantOperations(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    let changed = false;
    if (isConstant(ins, index)) {
      // --- We found a constant
      if (isUnary(ins, index + 1)) {
        // --- We can reduce an unary operation
        changed = reduceUnary(ins, index);
      } else if (isConstant(ins, index + 1) && isBinary(ins, index + 2)) {
        // --- We can reduce a binary operation
        changed = reduceBinary(ins, index);
      } else if (isBinary(ins, index + 1)) {
        if (isConstant(ins, index + 2) && isBinary(ins, index + 3)) {
          changed = reduceCascadedBinary(ins, index);
        } else {
          changed = reduceSecondConstOfBinary(ins, index);
        }
      } else if (isEqz(ins, index + 1) && isEqz(ins, index + 2)) {
        const value = ins[index] as ConstVal;
        ins[index] = constVal(value.valueType, value.value ? 1 : 0);
        ins.splice(index + 1, 2);
        changed = true;
      }
    }
    return changed;
  });
}

/**
 * Removed dead code from the specified block
 * @param instrs WA instructions to optimize
 * @param depth Current depth;
 */
function removeDeadCode(instrs: WaInstruction[], depth = 0): number {
  let changeCount = 0;
  let retIndex = -1;
  for (let i = instrs.length - 1; i >= 0; i--) {
    const instr = instrs[i];
    switch (instr.type) {
      case "Return":
        retIndex = depth === 0 ? i : i + 1;
        break;
      case "Branch":
        retIndex = i + 1;
        break;
      case "If":
        changeCount += removeDeadCode(instr.consequtive, depth + 1);
        if (instr.alternate) {
          changeCount += removeDeadCode(instr.alternate, depth + 1);
        }
        break;
      case "Block":
      case "Loop":
        changeCount += removeDeadCode(instr.body, depth + 1);
        break;
    }
  }
  if (retIndex >= 0) {
    const deleteCount = instrs.length - retIndex;
    instrs.splice(retIndex, deleteCount);
    if (deleteCount > 0) {
      changeCount++;
    }
  }
  return changeCount;
}

/**
 * Converts "if" instructions with a single "br" to "br_if"
 * @param instrs Instructions to convert
 */
function convertToBranchIf(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isIf(ins, index)) {
      const ifInstr = ins[index] as If;
      if (
        ifInstr.consequtive.length === 1 &&
        !ifInstr.alternate &&
        ifInstr.consequtive[0].type === "Branch"
      ) {
        ins[index] = branchIf(ifInstr.consequtive[0].label);
        return true;
      }
    }
    return false;
  });
}

/**
 * Reduces "const" and "br_if"
 * @param instrs Instructions to convert
 */
function reduceBranchIf(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isConstant(ins, index) && isBranchIf(ins, index + 1)) {
      const constVal = ins[index] as ConstVal;
      const branchIf = ins[index + 1] as BranchIf;
      if (constVal.value) {
        ins[index] = branch(branchIf.label);
        ins.splice(index + 1, 1);
        return true;
      } else {
        ins.splice(index, 2);
      }
    }
    return false;
  });
}

/**
 * Removes redundant branch statements
 * @param instrs Instructions to convert
 */
function removeRedundantBranch(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (
      (isBranch(ins, index) || isBranchIf(ins, index)) &&
      isBranch(ins, index + 1)
    ) {
      const br1Instr = ins[index] as Branch;
      const br2Instr = ins[index + 1] as Branch;
      if (br1Instr.label === br2Instr.label) {
        ins[index] = branch(br1Instr.label);
        ins.splice(index + 1, 1);
        return true;
      }
    }
    return false;
  });
}

/**
 * Changes "local_set" and "local_get" to "local_tee"
 * @param instrs Instructions to convert
 */
function optimizeLocalAccessors(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isLocalSet(ins, index) && isLocalGet(ins, index + 1)) {
      const localSet = ins[index] as LocalSet;
      const localGet = ins[index + 1] as LocalGet;
      if (localSet.id === localGet.id) {
        ins[index] = localTee(localSet.id);
        ins.splice(index + 1, 1);
        return true;
      }
    }
    return false;
  });
}

/**
 * Removes single local_tee instructions
 * @param instrs Instructions to convert
 */
function optimizeLocalTees(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isLocalTee(ins, index)) {
      const localTee = ins[index] as LocalTee;
      let teeCount = 0;
      visitInstructions(ins, (it) => {
        if (
          it.type.startsWith("Local") &&
          (it as LocalGet).id === localTee.id
        ) {
          teeCount++;
        }
      });
      if (teeCount === 1) {
        ins.splice(index, 1);
        return true;
      }
    }
    return false;
  });
}

/**
 * Optimizes "load" and "store" operations by using an offset value
 * @param instrs Instructions to convert
 */
function optimizeStoreOps(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (
      isConstant(ins, index) &&
      isAdd(ins, index + 1) &&
      (isLocalGet(ins, index + 2) || isGlobalGet(ins, index + 2)) &&
      (isStore(ins, index + 3))
    ) {
      const offset = (ins[index] as ConstVal).value;
      const storeOp = ins[index + 3] as Store;
      storeOp.offset = Number(offset);
      ins.splice(index, 2);
        return true;
    }
    return false;
  });
}

/**
 * Changes "const", "local_tee", and "local_get" to two "const" instructions
 * @param instrs Instructions to convert
 */
function optimizeConstantDuplication(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (
      isConstant(ins, index) &&
      isLocalTee(ins, index + 1) &&
      isLocalGet(ins, index + 2)
    ) {
      const constantToDupl = ins[index] as ConstVal;
      const localTee = ins[index + 1] as LocalTee;
      const localGet = ins[index + 2] as LocalGet;
      if (localTee.id === localGet.id) {
        ins[index + 1] = constVal(
          constantToDupl.valueType,
          constantToDupl.value
        );
        ins.splice(index + 2, 1);
        return true;
      }
    }
    return false;
  });
}

/**
 * Reduces "const" and "br_if"
 * @param instrs Instructions to convert
 */
function reduceIntegerCasts(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (
      isConstant(ins, index) &&
      isAnd(ins, index + 1) &&
      isStore(ins, index + 2)
    ) {
      const constVal = ins[index] as ConstVal;
      const store = ins[index + 2] as Store;
      if (
        (constVal.value === 0xffff && store.bits === WaBitSpec.Bit16) ||
        (constVal.value === 0xff && store.bits === WaBitSpec.Bit8)
      ) {
        ins.splice(index, 2);
        return true;
      }
    }
    return false;
  });
}

/**
 * Optimizes empty and branch-only loops
 * @param instrs Instructions to optimize
 */
function optimizeEmptyLoop(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    // --- Check for loops
    if (isLoop(ins, index)) {
      const loop = ins[index] as Loop;
      const body = loop.body;
      if (body.length === 0) {
        // --- Empty loop
        ins.splice(index, 1);
        return true;
      }
      if (
        body.length === 1 &&
        body[0].type === "Branch" &&
        body[0].label !== loop.id
      ) {
        // --- Branch-only loop
        ins[index] = branch(body[0].label);
        return true;
      }
      if (
        body.length === 1 &&
        body[0].type === "BranchIf" &&
        body[0].label !== loop.id
      ) {
        // --- Branch-only loop
        ins[index] = branchIf(body[0].label);
        return true;
      }
    }
    return false;
  });
}

/**
 * Optimizes empty and branch-only loops
 * @param instrs Instructions to optimize
 */
function optimizeEmptyBlock(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    // --- Check for block
    if (isBlock(ins, index)) {
      const block = ins[index] as Block;
      const body = block.body;
      if (body.length === 0) {
        // --- Empty loop
        ins.splice(index, 1);
        return true;
      }
      if (
        body.length === 1 &&
        body[0].type === "Branch" &&
        body[0].label === block.id
      ) {
        // --- Branch-only block
        ins.splice(index, 1);
        return true;
      }
      if (
        body.length === 1 &&
        body[0].type === "BranchIf" &&
        body[0].label === block.id
      ) {
        // --- Branch-only block
        ins.splice(index, 1);
        return true;
      }
    }
    return false;
  });
}

/**
 * Peels a loop that does not have a branch to itself
 * @param instrs Instructions to optimize
 */
function peelLoop(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isLoop(ins, index)) {
      const loop = ins[index] as Loop;
      if (
        !findInstruction(
          loop.body,
          (item) =>
            (item.type === "Branch" || item.type === "BranchIf") &&
            item.label === loop.id
        )
      ) {
        ins.splice(index, 1, ...loop.body);
        return true;
      }
    }
    return false;
  });
}

/**
 * Peels a block that has only branches to itself
 * @param instrs Instructions to optimize
 */
function peelBlock(instrs: WaInstruction[]): number {
  return instructionsActionLoop(instrs, (ins, index) => {
    if (isBlock(ins, index)) {
      const block = ins[index] as Block;
      const reducedBody: WaInstruction[] = [];
      let hasBranchOut = false;
      block.body.forEach((item) => {
        if (item.type === "Branch") {
          hasBranchOut ||= item.label !== block.id;
        } else {
          reducedBody.push(item);
          if (item.type === "Loop" || item.type === "Block") {
            hasBranchOut ||= findInstruction(
              item.body,
              (it) =>
                (it.type === "Branch" || it.type === "BranchIf") &&
                it.label === block.id
            );
          } else if (item.type === "If") {
            hasBranchOut ||= findInstruction(
              item.consequtive,
              (it) =>
                (it.type === "Branch" || it.type === "BranchIf") &&
                it.label === block.id
            );
            if (item.alternate) {
              hasBranchOut ||= findInstruction(
                item.alternate,
                (it) =>
                  (it.type === "Branch" || it.type === "BranchIf") &&
                  it.label === block.id
              );
            }
          }
        }
      });
      if (
        !hasBranchOut &&
        !block.body.some((item) => item.type === "BranchIf")
      ) {
        ins.splice(index, 1, ...reducedBody);
        return true;
      }
    }
    return false;
  });
}

/**
 * Reduces the unary operation at the specified index
 * @param instrs Instructions
 * @param index Constant value index (followed by the unary op)
 * @returns true, if the operation has been reduced
 */
function reduceUnary(instrs: WaInstruction[], index: number): boolean {
  const operand = instrs[index] as ConstVal;
  const operandValue = operand.value;
  const waType = operand.valueType;
  const op = instrs[index + 1];
  let newInstr: WaInstruction | undefined;
  switch (op.type) {
    case "Extend32":
      if (waType === WaType.i32) {
        newInstr = constVal(WaType.i64, operandValue);
      }
      break;
    case "Demote64":
      if (waType === WaType.f64) {
        newInstr = constVal(WaType.f32, operandValue);
      }
      break;
  }
  if (newInstr) {
    instrs[index] = newInstr;
    instrs.splice(index + 1, 1);
    return true;
  }
  return false;
}

/**
 * Reduces the binary operation at the specified index
 * @param instrs Instructions
 * @param index Constant value index (followed by the second operand and the binary op)
 * @returns true, if the operation has been reduced
 */
function reduceBinary(instrs: WaInstruction[], index: number): boolean {
  const leftOp = instrs[index] as ConstVal;
  const left = leftOp.value;
  const waType = leftOp.valueType;
  const right = (instrs[index + 1] as ConstVal).value;
  const op = instrs[index + 2];
  let value: number | bigint | null = null;
  switch (op.type) {
    case "Mul":
      value =
        typeof left === "number" && typeof right === "number"
          ? left * right
          : BigInt(left) * BigInt(right);
      break;

    case "Add":
      value =
        typeof left === "number" && typeof right === "number"
          ? left + right
          : BigInt(left) + BigInt(right);
      break;

    case "And":
      value =
        typeof left === "number" && typeof right === "number"
          ? left & right
          : BigInt(left) & BigInt(right);
      break;

    case "Or":
      value =
        typeof left === "number" && typeof right === "number"
          ? left | right
          : BigInt(left) | BigInt(right);
      break;

    case "Xor":
      value =
        typeof left === "number" && typeof right === "number"
          ? left ^ right
          : BigInt(left) ^ BigInt(right);
      break;

    case "Shl":
      value =
        typeof left === "number" && typeof right === "number"
          ? left << right
          : BigInt(left) << BigInt(right);
      break;

    case "Shr":
      if (op.signed) {
        value =
          typeof left === "number" && typeof right === "number"
            ? left >> right
            : BigInt(left) >> BigInt(right);
      } else {
        value =
          typeof left === "number" && typeof right === "number"
            ? left >>> right
            : Number(left) >>> Number(right);
      }
      break;
  }
  if (value !== null) {
    instrs[index] = constVal(waType, value);
    instrs.splice(index + 1, 2);
    return true;
  }
  return false;
}

/**
 * Reduces the binary operation at the specified index
 * @param instrs Instructions
 * @param index Constant value index (const, binary, const, binary)
 * @returns true, if the operation has been reduced
 */
function reduceCascadedBinary(instrs: WaInstruction[], index: number): boolean {
  const leftOp = instrs[index] as ConstVal;
  const left = leftOp.value;
  const waType = leftOp.valueType;
  const right = (instrs[index + 2] as ConstVal).value;
  const opsType = instrs[index + 1].type + instrs[index + 3].type;
  let value: number | bigint | null = null;
  let updatedOp: WaInstruction;
  switch (opsType) {
    case "AddAdd":
      value =
        typeof left === "number" && typeof right === "number"
          ? left + right
          : BigInt(left) + BigInt(right);
      updatedOp = add(waType);
      break;

    case "SubSub":
      value =
        typeof left === "number" && typeof right === "number"
          ? left + right
          : BigInt(left) + BigInt(right);
      updatedOp = sub(waType);
      break;
  }
  if (value !== null) {
    instrs[index] = constVal(waType, value);
    instrs[index + 1] = updatedOp;
    instrs.splice(index + 2, 2);
    return true;
  }
  return false;
}

/**
 * Reduces the second constant of a binary operation
 * @param instrs Instructions
 * @param index Constant value index (const, binary)
 * @returns true, if the operation has been reduced
 */
function reduceSecondConstOfBinary(
  instrs: WaInstruction[],
  index: number
): boolean {
  const operand = instrs[index] as ConstVal;
  const opType = instrs[index + 1].type;
  switch (opType) {
    case "Add":
    case "Sub":
      if (operand.value === 0) {
        instrs.splice(index, 2);
        return true;
      }
      break;
    case "Mul":
    case "Div":
      if (operand.value === 1) {
        instrs.splice(index, 2);
        return true;
      }
      break;
  }
  return false;
}

/**
 * Tests if the specified instruction is a constant
 * @param index Instruction index in the function body
 */
function isConstant(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 &&
    index < instrs.length &&
    instrs[index].type === "ConstVal"
  );
}

/**
 * Tests if the specified instruction is a unary operation
 * @param index Instruction index in the function body
 */
function isUnary(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 &&
    index < instrs.length &&
    instructionTraits[instrs[index].type] === InstructionType.Unary
  );
}

/**
 * Tests if the specified instruction is a binary operation
 * @param index Instruction index in the function body
 */
function isBinary(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 &&
    index < instrs.length &&
    instructionTraits[instrs[index].type] === InstructionType.Binary
  );
}

/**
 * Tests if the specified instruction is a constant
 * @param index Instruction index in the function body
 */
 function isAdd(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 &&
    index < instrs.length &&
    instrs[index].type === "Add"
  );
}

/**
 * Tests if the specified instruction is "eqz"
 * @param index Instruction index in the function body
 */
function isEqz(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Eqz";
}

/**
 * Tests if the specified instruction is an "if" operation
 * @param index Instruction index in the function body
 */
function isIf(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "If";
}

/**
 * Tests if the specified instruction is a "br" operation
 * @param index Instruction index in the function body
 */
function isBranch(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Branch";
}

/**
 * Tests if the specified instruction is a "br" operation
 * @param index Instruction index in the function body
 */
function isBranchIf(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 && index < instrs.length && instrs[index].type === "BranchIf"
  );
}

/**
 * Tests if the specified instruction is a "local_get" operation
 * @param index Instruction index in the function body
 */
function isLocalGet(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 && index < instrs.length && instrs[index].type === "LocalGet"
  );
}

/**
 * Tests if the specified instruction is a "local_set" operation
 * @param index Instruction index in the function body
 */
function isLocalSet(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 && index < instrs.length && instrs[index].type === "LocalSet"
  );
}

/**
 * Tests if the specified instruction is a "local_tee" operation
 * @param index Instruction index in the function body
 */
function isLocalTee(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 && index < instrs.length && instrs[index].type === "LocalTee"
  );
}

/**
 * Tests if the specified instruction is a "global_get" operation
 * @param index Instruction index in the function body
 */
function isGlobalGet(instrs: WaInstruction[], index: number): boolean {
  return (
    index >= 0 && index < instrs.length && instrs[index].type === "GlobalGet"
  );
}

/**
 * Tests if the specified instruction is a "block" operation
 * @param index Instruction index in the function body
 */
function isBlock(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Block";
}

/**
 * Tests if the specified instruction is a "loop" operation
 * @param index Instruction index in the function body
 */
function isLoop(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Loop";
}

/**
 * Tests if the specified instruction is a "store" operation
 * @param index Instruction index in the function body
 */
function isStore(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Store";
}

/**
 * Tests if the specified instruction is a "store" operation
 * @param index Instruction index in the function body
 */
 function isLoad(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "Load";
}

/**
 * Tests if the specified instruction is an "and" operation
 * @param index Instruction index in the function body
 */
function isAnd(instrs: WaInstruction[], index: number): boolean {
  return index >= 0 && index < instrs.length && instrs[index].type === "And";
}

/**
 * Type of a particular instruction
 */
enum InstructionType {
  None,
  Const,
  Unary,
  Binary,
}

/**
 * Traits of instrcutions
 */
type InstructionTraits = Record<WaInstruction["type"], InstructionType>;

const instructionTraits: InstructionTraits = {
  Abs: InstructionType.Unary,
  Add: InstructionType.Binary,
  And: InstructionType.Binary,
  Block: InstructionType.None,
  Branch: InstructionType.None,
  BranchIf: InstructionType.None,
  BranchTable: InstructionType.None,
  Call: InstructionType.None,
  CallIndirect: InstructionType.None,
  Ceil: InstructionType.None,
  Clz: InstructionType.None,
  Comment: InstructionType.None,
  ConstVal: InstructionType.Const,
  Convert32: InstructionType.None,
  Convert64: InstructionType.None,
  CopySign: InstructionType.None,
  Ctz: InstructionType.None,
  Demote64: InstructionType.Unary,
  Div: InstructionType.Binary,
  Drop: InstructionType.None,
  Eq: InstructionType.Binary,
  Eqz: InstructionType.None,
  Extend32: InstructionType.Unary,
  Floor: InstructionType.None,
  Ge: InstructionType.Binary,
  GlobalGet: InstructionType.None,
  GlobalSet: InstructionType.None,
  Gt: InstructionType.Binary,
  If: InstructionType.None,
  Le: InstructionType.Binary,
  Load: InstructionType.None,
  LocalGet: InstructionType.None,
  LocalSet: InstructionType.None,
  LocalTee: InstructionType.None,
  Loop: InstructionType.None,
  Lt: InstructionType.Binary,
  Max: InstructionType.Binary,
  Min: InstructionType.Binary,
  MemoryGrow: InstructionType.None,
  MemorySize: InstructionType.None,
  Mul: InstructionType.Binary,
  Ne: InstructionType.Binary,
  Nearest: InstructionType.None,
  Neg: InstructionType.None,
  Nop: InstructionType.None,
  Or: InstructionType.Binary,
  PopCnt: InstructionType.None,
  Promote32: InstructionType.None,
  ReinterpretF32: InstructionType.None,
  ReinterpretF64: InstructionType.None,
  ReinterpretI32: InstructionType.None,
  ReinterpretI64: InstructionType.None,
  Rem: InstructionType.Binary,
  Return: InstructionType.None,
  Rotl: InstructionType.None,
  Rotr: InstructionType.None,
  Select: InstructionType.None,
  SeparatorLine: InstructionType.None,
  Shl: InstructionType.Binary,
  Shr: InstructionType.Binary,
  Sqrt: InstructionType.None,
  Store: InstructionType.None,
  Sub: InstructionType.Binary,
  Trunc: InstructionType.None,
  Trunc32: InstructionType.None,
  Trunc64: InstructionType.None,
  Unreachable: InstructionType.None,
  Wrap64: InstructionType.None,
  Xor: InstructionType.Binary,
};
