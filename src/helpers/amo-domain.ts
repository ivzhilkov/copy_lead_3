export const normalizeAmoDomain = (value?: string | null) => {
  const domain = String(value || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  if (!domain) return '';
  if (domain.includes('.')) return domain;

  return `${domain}.amocrm.ru`;
};

