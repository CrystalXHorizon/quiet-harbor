export function chineseValidation(input) {
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('invalid', () => {
    input.setCustomValidity('');
    const v = input.validity;
    input.setCustomValidity(v.valueMissing ? '请填写这一项。' : v.typeMismatch ? '请填写有效的邮箱地址。' : v.tooShort ? `请至少填写 ${input.minLength} 个字符。` : v.patternMismatch ? '请按要求填写，例如 6 位数字验证码。' : '请检查内容长度或数值范围。');
  });
  return input;
}
