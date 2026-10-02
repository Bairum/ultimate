/** The reading column of the transcript and composer; `dock` fits them into a narrow side region. */
export const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-[46rem] px-6'
