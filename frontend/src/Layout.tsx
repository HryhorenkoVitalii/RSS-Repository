import { NavLink, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <>
      <header className="header">
        <h1>RSS Repository</h1>
        <nav className="header-nav">
          <NavLink className="nav-link" to="/" end>
            Feeds
          </NavLink>
          <NavLink className="nav-link" to="/articles">
            Articles
          </NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
