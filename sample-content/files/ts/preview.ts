type Preview = { title: string; url: URL };

export const describe = ({ title, url }: Preview): string =>
  `${title} — ${url.hostname}`;
