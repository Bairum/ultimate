/** The reading column of the transcript and composer; `dock` fits them beside a view. */
export const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-[46rem] px-6'
